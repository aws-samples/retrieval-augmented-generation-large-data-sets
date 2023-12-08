sudo -i
mkdir -p /rag
cd /rag

export AWS_REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/availability-zone | sed 's/\(.*\)[a-z]/\1/')
aws configure set region $AWS_REGION

aws s3 cp s3://{{ BucketName }}/scripts_ray/ . --recursive


cat << EOF > llm-batch-inference.yaml
# An unique identifier for the head node and workers of this cluster.
cluster_name: llm-batch-inference

max_workers: 5

# Cloud-provider specific configuration.
provider:
    type: aws
    region: $AWS_REGION
    use_internal_ips: true

# List of shell commands to run to set up nodes.
setup_commands:
    - >-
        (stat \$HOME/anaconda3/envs/tensorflow2_p38/ &> /dev/null &&
        echo 'export PATH="\$HOME/anaconda3/envs/tensorflow2_p38/bin:\$PATH"' >> ~/.bashrc) || true
    - which ray || pip install -U "ray[default]==2.5.1"
    - pip install "pydantic<2"

available_node_types:
  ray.head.default:
      resources: {{{ RayHeadNodeResources }}}
      node_config:
        InstanceType: {{ RayHeadNodeInstanceType }}
        IamInstanceProfile:
            Arn: {{ RayHeadNodeIamProfileArn }}
        SubnetIds:
            - {{ RaySubnet1 }}
            - {{ RaySubnet2 }}
            - {{ RaySubnet3 }}
        SecurityGroupIds:
            - {{ RaySecurityGroup }}
        BlockDeviceMappings:
            - DeviceName: /dev/sda1
              Ebs:
                  VolumeSize: 10000
  ray.worker.default:
      node_config:
        InstanceType: {{ RayWorkerNodeInstanceType }}
        IamInstanceProfile:
            Arn: {{ RayWorkerNodeIamProfileArn }}
        SubnetIds:
            - {{ RaySubnet1 }}
            - {{ RaySubnet2 }}
            - {{ RaySubnet3 }}
        SecurityGroupIds:
            - {{ RaySecurityGroup }}
        BlockDeviceMappings:
            - DeviceName: /dev/sda1
              Ebs:
                  VolumeSize: 10000
      resources: {{{ RayWorkerNodeResources }}}
      min_workers: {{ RayWorkerNodeMin }}
      max_workers: {{ RayWorkerNodeMax }}
EOF