from typing import List
import pandas as pd
import ray
from langchain.text_splitter import RecursiveCharacterTextSplitter
from sentence_transformers import SentenceTransformer
from langchain.embeddings import HuggingFaceEmbeddings
import numpy as np
import boto3
import time
import requests
import json
import os
import psycopg2
from pgvector.psycopg2 import register_vector

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

model_name = "sentence-transformers/all-mpnet-base-v2"

# Data set has one question per row
ds = ray.data.read_text(f"s3://{bucket_name}/oscar/questions/questions.csv")

class Embed:
    def __init__(self):
        # Specify "cuda" to move the model to GPU.
        self.model_name = "sentence-transformers/all-mpnet-base-v2"
        self.transformer = SentenceTransformer(self.model_name, device="cuda")
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
                        'MetricName': 'querytime',
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
        embeddings = self.transformer.encode(
            text_batch['text'].tolist(),
            batch_size=100,  # Large batch size to maximize GPU utilization.
            device="cuda",
        ).tolist()

        dbconn = psycopg2.connect(host=self.dbhost, 
                                       user=self.dbuser, 
                                       password=self.dbpass, 
                                       port=self.dbport, 
                                       connect_timeout=10)
        dbconn.set_session(autocommit=True)
        cur = dbconn.cursor()



        r = list(zip(text_batch['text'].tolist(), embeddings))
        for i, (t, e) in enumerate(r):
            try:
                t1 = time.time()
                cur.execute(f"SELECT id, passage, descriptions_embeddings FROM products ORDER BY descriptions_embeddings <-> '{e}' limit 2;")
                t2 = time.time()
                self.put_cloudwatch_metric((t2-t1) * 1000.0)
                dbr = cur.fetchall()
                print(f"Got response: {[p[1] for p in dbr]}")
            except Exception as e:
                print(f"Error querying RDS: {e}")

        cur.close()
        dbconn.close()

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