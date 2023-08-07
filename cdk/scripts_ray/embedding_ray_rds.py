from typing import List
import pandas as pd
import ray
import uuid
from langchain.text_splitter import RecursiveCharacterTextSplitter
from sentence_transformers import SentenceTransformer
from langchain.embeddings import HuggingFaceEmbeddings
import psycopg2
from pgvector.psycopg2 import register_vector
import boto3
import time
import requests
import json
import os

os.environ["RAY_DATA_STRICT_MODE"]="0"
ray.init(
    runtime_env={"pip": ["langchain", "sentence_transformers", "transformers","psycopg2-binary", "pgvector"],
                 "env_vars":{"RAY_DATA_STRICT_MODE":"0" }
                 }
)

# get region
token_url = 'http://169.254.169.254/latest/api/token'
headers = {'X-aws-ec2-metadata-token-ttl-seconds': '21600'}
response = requests.put(token_url, headers=headers)
token = response.text
response = requests.get('http://169.254.169.254/latest/meta-data/placement/availability-zone', headers={'X-aws-ec2-metadata-token': token})
availability_zone = response.text
region = availability_zone[:-1]

#Get variables from cloudformation output of RagStack
cfn_client = boto3.client('cloudformation')
stack_name = 'RAGStack'
stack_outputs = cfn_client.describe_stacks(StackName=stack_name)['Stacks'][0]['Outputs']
for output in stack_outputs:
    if output['OutputKey'] == 'bucketName':
        bucket_name = output['OutputValue']
    if output['OutputKey'] == 'rdsSecretARN':
        rds_secret_arn = output['OutputValue']
    if output['OutputKey'] == 'rdsEndpoint':
        dbhost = output['OutputValue']

# Read data
ds = ray.data.read_parquet(f"s3://{bucket_name}/oscar/parquet_data/")
train, test = ds.train_test_split(test_size=0.1)
ds = test

# Convert to text only
def convert_to_text(batch: pd.DataFrame) -> List[str]:
    return list(batch["content"])
ds = ds.map_batches(convert_to_text)

# Split into chunks
def split_text(page_text: str):
    # Use chunk_size of 1000.
    # We felt that the answer we would be looking for would be 
    # around 200 words, or around 1000 characters.
    # This parameter can be modified based on your documents and use case.
    text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=1000, chunk_overlap=100, length_function=len
    )
    if page_text and len(page_text) > 0:
        split_text: List[str] = text_splitter.split_text(page_text)
        split_text = [text.replace("\n", " ") for text in split_text]
        return split_text
    else:
        return []
ds = ds.flat_map(split_text)

# Create embeddings
model_name = "sentence-transformers/all-mpnet-base-v2"

class Embed:
    def __init__(self):
        # Specify "cuda" to move the model to GPU.
        self.transformer = SentenceTransformer(model_name, device="cuda")
        self.embedding_hf=HuggingFaceEmbeddings(model_name=model_name)
        self.rds_client = boto3.client('secretsmanager',region_name=region)
        self.rds_secret = json.loads(self.rds_client.get_secret_value(SecretId=rds_secret_arn)['SecretString'])
        self.dbpass = self.rds_secret['password']
        self.dbuser = self.rds_secret['username']
        self.dbport = 5432
        self.dbhost = dbhost
        self.cloudwatch = boto3.client("cloudwatch", region_name=region)
        self.namespace = 'RAG'
        self.vectordb = 'rds'
        os.environ["RAY_DATA_STRICT_MODE"]="0"

    def put_cloudwatch_metric(self, time_ms):
        try:
            self.cloudwatch.put_metric_data(
                Namespace=self.namespace,
                MetricData=[
                    {
                        'MetricName': 'ingesttime',
                        'Dimensions': [
                            {
                                'Name': 'vectordb',
                                'Value': self.vectordb
                            }
                        ],
                        'Value': time_ms,
                        'Unit': 'Milliseconds'
                    }
                ]
            )
        except Exception as e:
            print(f"Error writing to CloudWatch: {e}")

    def __call__(self, text_batch: List[str]):
        # We manually encode using sentence_transformer since LangChain
        # HuggingfaceEmbeddings does not support specifying a batch size yet.
        try:
            dbconn = psycopg2.connect(host=self.dbhost, 
                                        user=self.dbuser, 
                                        password=self.dbpass, 
                                        port=self.dbport, 
                                        connect_timeout=10)
            dbconn.set_session(autocommit=True)
            cur = dbconn.cursor()
            cur.execute("CREATE EXTENSION IF NOT EXISTS vector;")
            register_vector(dbconn)

            embeddings = self.transformer.encode(
                text_batch,
                batch_size=100,  # Large batch size to maximize GPU utilization.
                device="cuda",
            ).tolist()

            insert_ids = [str(uuid.uuid4()) for i in range(len(embeddings))]
            r = list(zip(insert_ids, text_batch, embeddings))
            insert_args = ','.join(cur.mogrify("(%s,%s,%s)", i).decode('utf-8') for i in r)
            t1 = time.time()
            cur.execute("INSERT INTO products (id, passage, descriptions_embeddings) VALUES " + (insert_args))
            t2 = time.time()
            self.put_cloudwatch_metric((t2-t1) * 1000.0)

            cur.close()
            dbconn.close()
        except Exception as e:
            print(f"Error ingesting to RDS: {e}")

        return r
ds = ds.map_batches(
    Embed,
    # Large batch size to maximize GPU utilization.
    # Too large a batch size may result in GPU running out of memory.
    # If the chunk size is increased, then decrease batch size.
    # If the chunk size is decreased, then increase batch size.
    batch_size=100,  # Large batch size to maximize GPU utilization.
    compute=ray.data.ActorPoolStrategy(min_size=20, max_size=20),  # I have 20 GPUs in my cluster
    num_gpus=1,  # 1 GPU for each actor.
)

ds.count()