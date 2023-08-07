import psycopg2
from pgvector.psycopg2 import register_vector
import json
import boto3

#Get variables from cloudformation output of RagStack
cfn_client = boto3.client('cloudformation')
stack_name = 'RAGStack'
stack_outputs = cfn_client.describe_stacks(StackName=stack_name)['Stacks'][0]['Outputs']
for output in stack_outputs:
    if output['OutputKey'] == 'rdsSecretARN':
        rds_secret_arn = output['OutputValue']
    if output['OutputKey'] == 'rdsEndpoint':
        dbhost = output['OutputValue']

#Get the RDS secret
rds_client = boto3.client('secretsmanager')
rds_secret = json.loads(rds_client.get_secret_value(SecretId=rds_secret_arn)['SecretString'])
dbpass = rds_secret['password']
dbuser = rds_secret['username']
dbport = 5432

dbconn = psycopg2.connect(host=dbhost, user=dbuser, password=dbpass, port=dbport, connect_timeout=10)
dbconn.set_session(autocommit=True)

cur = dbconn.cursor()
cur.execute("CREATE EXTENSION IF NOT EXISTS vector;")
register_vector(dbconn)
cur.execute("DROP TABLE IF EXISTS products;")
cur.execute("""CREATE TABLE IF NOT EXISTS products(
               id text primary key, 
               passage text,
               descriptions_embeddings vector(768));""")

cur.execute("""CREATE INDEX ON products 
               USING ivfflat (descriptions_embeddings vector_l2_ops) WITH (lists = 500);""")
cur.execute("VACUUM ANALYZE products;")

cur.close()
dbconn.close()