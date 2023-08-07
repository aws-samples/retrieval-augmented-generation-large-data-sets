sudo apt-get update
sudo apt-get install -y binutils git-lfs python3-pip awscli zstd jq unzip postgresql

pip install boto3
pip install 'ray[default]'
pip install opensearch-py
pip install psycopg2-binary
pip install pgvector
pip install pinecone-client

curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip
sudo ./aws/install

python3 -m pip install --upgrade pip -y
python3 -m pip uninstall awscli -y
python3 -m pip install awscli 