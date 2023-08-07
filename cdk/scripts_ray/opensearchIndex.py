import requests
import boto3
from opensearchpy import OpenSearch

#Get variables from cloudformation output of RagStack
cfn_client = boto3.client('cloudformation')
stack_name = 'RAGStack'
stack_outputs = cfn_client.describe_stacks(StackName=stack_name)['Stacks'][0]['Outputs']
for output in stack_outputs:
    if output['OutputKey'] == 'opensearchUrl':
        URL = output['OutputValue']
    if output['OutputKey'] == 'bucketName':
        bucket_name = output['OutputValue']



DOMAIN = 'genai'
mapping = {
    'settings': {
        'index': {
            'knn': True,  # Enable k-NN search for this index
            "refresh_interval": "30s",
            "knn.algo_param.ef_search": 100
        }
    },
    'mappings': {
        'properties': {
            'embedding': {  # k-NN vector field
                'type': 'knn_vector',
                'dimension': 768, # Dimension of the vector
                'method': {
                    'name': 'hnsw',
                    'space_type': 'l2',
                    'engine': "nmslib",
                    "parameters": {
                        "ef_construction": 256,
                        "m": 16,
                    },
                },
            },
            'passage': {
                'type': 'text'
            },
            'doc_id': {
                'type': 'keyword'
            }
        }
    }
}
response = requests.head(f"{URL}/{DOMAIN}")
# If the index does not exist (status code 404), create the index
if response.status_code == 404:
    response = requests.put(f"{URL}/{DOMAIN}", json=mapping)
    print(f'Index created: {response.text}')
else:
    print('Index already exists!')
