import sys
import boto3
from datetime import date

from pyspark.sql import SparkSession, DataFrame, Row
from pyspark.sql import functions as F

if __name__ == "__main__":
    #Get Bucket name from the cloudformation output of RagStack
    cfn_client = boto3.client('cloudformation')
    stack_name = 'RAGStack'
    stack_outputs = cfn_client.describe_stacks(StackName=stack_name)['Stacks'][0]['Outputs']
    for output in stack_outputs:
        if output['OutputKey'] == 'bucketName':
            bucket_name = output['OutputValue']
            break

    spark = SparkSession.builder.appName("oscar").getOrCreate()
    j = spark.read.json(f's3://{bucket_name}/oscar/jsonl/')
    j.write.parquet(f's3://{bucket_name}/oscar/parquet_data/')