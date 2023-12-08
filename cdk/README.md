# Retrieval-augmented generation on large data sets

## Set up infrastructure

Pre-requsities: 

Clone the repo or download the zip file for the rag stack.

Before proceeding with the installation, under cdk->bin-> src.tc, change the boolean values for Amazon RDS and Amazon OpenSearch to etiher true or false depending on your preference. Save and then proceed to CDK deployment below.

Start by deploying the CDK stack.

If you have not created an OpenSearch domain before, create a service-linked role as documented [here](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_opensearchservice-readme.html#a-note-about-slr). You can also run the below command to create the role.

```bash
aws iam create-service-linked-role --aws-service-name es.amazonaws.com
```


```bash
npm install
cdk deploy
```

This CDK stack will deploy the following infrastructure.

- Amazon VPC
- JumpHost (inside the VPC)
- Amazon OpenSearch Cluster (if Amazon Opensearch was selected "true")
- Amazon RDS Instance (if Amazon RDS was selected "true")
- Amazon SSM Doc for deploying Ray Cluster
- Amazon S3 bucket
- Amazon Glue job for converting OSCAR dataset jsonl files to parquet
- Amazon CloudWatch Dashboard


## Download the data

The OSCAR dataset is around 4.5TB of data and this step takes about a day to download files depending on network bandwidth.

Run these from the jump host

```bash
stack_name="RAGStack"
output_key="S3bucket"

export AWS_REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/availability-zone | sed 's/\(.*\)[a-z]/\1/')
aws configure set region $AWS_REGION

bucket_name=$(aws cloudformation describe-stacks --stack-name "$stack_name" --query "Stacks[0].Outputs[?OutputKey=='bucketName'].OutputValue" --output text )

```
Before cloning the git repo, please make sure you have hugging face profile and access to the OSCAR data corpus. You will need to use the username and password for cloning the OSCAR data below

``` bash

GIT_LFS_SKIP_SMUDGE=1 git clone https://huggingface.co/datasets/oscar-corpus/OSCAR-2301
cd OSCAR-2301
git lfs pull --include en_meta

# The above step will download the data on Jumphost and will take around 2 hours to complete. 
# After the donwload is completed, run the following steps to extract jsonl files.

cd en_meta
for F in `ls *.zst`; do zstd -d $F; done
rm *.zst
cd ..
aws s3 sync en_meta s3://$bucket_name/oscar/jsonl/

```
## Convert jsonl files to Parquet


A ```Glue ETL``` job ```oscar-jsonl-parquet``` is created that could be used to convert the oscar data from jsonl to parquet format. 

```Run``` the glue job ```oscar-jsonl-parquet```. The files in parquet format should be available under the ```parquet``` folder in the s3 bucket.  


## Download the questions

From your jumphost download the questions data and upload it to your bucket.


```bash
stack_name="RAGStack"
output_key="S3bucket"

export AWS_REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/availability-zone | sed 's/\(.*\)[a-z]/\1/')
aws configure set region $AWS_REGION

bucket_name=$(aws cloudformation describe-stacks --stack-name "$stack_name" --query "Stacks[0].Outputs[?OutputKey=='bucketName'].OutputValue" --output text )

wget https://rajpurkar.github.io/SQuAD-explorer/dataset/train-v2.0.json
cat train-v2.0.json| jq '.data[].paragraphs[].qas[].question' > questions.csv
aws s3 cp questions.csv s3://$bucket_name/oscar/questions/questions.csv
```

## Setup the Ray Cluster
As part of the CDK deploy, we created an SSM document called ```CreateRayCluster```.
To deploy run the SSM document. 
Go to SSM -> Documents -> Owned by Me.
Select the ```CreateRayCluster``` document.
From the next screen, click ```run command```. 
The run command screen will have default values populated for the cluster. 

***NOTE*** the default configuration requests 5 ```g4dn.12xlarge```. Make sure your account has limits to support this.
The relevant service limit is ```Running On-Demand G and VT instances```. The default for this is ```64```, but this configuration requires ```240``` CPUS.

After reviewing the cluster configuration, select the ```jumphost``` as the target for the run command.
This command will perform the following steps

- Copy the Ray Cluster files
- Setup the Ray Cluster
- Setup the OpenSearch Indexes
- Setup the RDS Postgres Tables

You can monitor the output of the commands from SSM. 
This process will take ~10-15 minutes for the initial launch.

## Run Ingestion
From the jump host connect to the ray cluster

```bash
sudo -i
cd /rag
ray attach llm-batch-inference.yaml
```

The first time connecting to the host, install the requirements.
These files should already be present on the head node.

```bash
pip install -r requirements.txt
```

***NOTE*** For any of the ingestion methods, if you get an error like below, its related to expired credentials.
Current workaround is to place credential files in on the ray head node. 


```bash
OSError: When reading information for key 'oscar/parquet_data/part-00497-f09c5d2b-0e97-4743-ba2f-1b2ad4f36bb1-c000.snappy.parquet' in bucket 'ragstack-s3bucket07682993-1e3dic0fvr3rf': AWS Error [code 15]: No response body.
```

Usually the credentials are stored in this file ```~/.aws/credentials``` on Linux and macOS systems, and ```%USERPROFILE%\.aws\credentials``` on Windows but these are short term credentials with session token. You also cannot override the default credential file and so we need to create long term credentials without the session token using a new IAM user. Follow the step below:

To create long term credentials, you need to generate ```AWS Access Key``` and ```AWS Secret access key```. You can do that from IAM in the AWS Console. Follow this link to create and retrieve AWS credentials https://docs.aws.amazon.com/cli/latest/userguide/cli-authentication-user.html

Once the keys are created, Connect to EC2 jumphost using session manager and run the below command

```
$ aws configure
AWS Access Key ID [None]: <Your AWS Access Key>
AWS Secret Access Key [None]: <Your AWS Secret access key>
Default region name [None]: us-east-1
Default output format [None]: json
```
Now, re-run the steps in  ```Run Ingestion``` step

## Opensearch
Next run this script to ingest the files

```bash
export AWS_REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/availability-zone | sed 's/\(.*\)[a-z]/\1/')
aws configure set region $AWS_REGION

python embedding_ray_os.py
```

Once this completes, kick off the script that runs simulated queries:

```bash
python query_os.py
```

## RDS
Next run this script to ingest the files

```bash
export AWS_REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/availability-zone | sed 's/\(.*\)[a-z]/\1/')
aws configure set region $AWS_REGION

python embedding_ray_rds.py
```

After this is complete, make sure to run a full Vacuum on the RDS instance.


Once this completes, kick off the script that runs simulated queries:

```bash
python query_rds.py
```


## Setting up Ray Dashboard

```Pre-requisites```: Install the AWS CLI on your local machine. Make sure your selected aws region is the one in which the ray setup is done.  Refer to this link for installation https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html

Step 1: Install the Session Manager plugin for the AWS CLI. Follow this link https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html

Step 2: In the Isengard account, copy the "temporary credentials" for ```bash/zsh``` and run in your local terminal

Step 3: Create a session.sh file in your machine and copy the below content to the file
```
#!/bin/bash
echo Starting session to $1 to forward to port $2 using local port $3
aws ssm start-session --target $1 --document-name AWS-StartPortForwardingSession --parameters ‘{“portNumber”:[“‘$2’“], “localPortNumber”:[“‘$3’“]}'
```

Step 4: Change directory to where this session.sh file is stored.

Step 5: Run the command ```Chmod +x``` to give executable permission to the file

Step 6: Run the below command 
```
./session.sh  <Ray cluster head node instance ID> 8265 8265 
```

Example: 
```
./session.sh  i-021821beb88661ba3 8265 8265
```

You will see a message like this

```
Starting session to i-021821beb88661ba3 to forward to port 8265 using local port 8265

Starting session with SessionId: *****-Isengard-******
Port 8265 opened for sessionId *****-Isengard-******.
Waiting for connections...

```

Step 7: Open a new tab in your browser, and type ```localhost:8265```
You will see the Ray dashboard and statistics of the Jobs and Cluster running. You can then track metrics from here.

Note: You can also go to CloudWatch -> Dashboards -> RAG_Benchmarks to see ingestion rate and query response times
