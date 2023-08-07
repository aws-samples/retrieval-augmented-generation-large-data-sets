import * as cdk from 'aws-cdk-lib';
import { aws_ec2 as ec2 } from 'aws-cdk-lib';
import { readFileSync } from 'fs';
import { Construct } from 'constructs';
import * as ssm from '@cdklabs/cdk-ssm-documents'

interface RayClusterProps {
    vpc: cdk.aws_ec2.Vpc;
    jumphost: ec2.Instance;
    bucket: cdk.aws_s3.Bucket
}

export class RayCluster extends Construct {
    public readonly raySecurityGroup: ec2.SecurityGroup;
    public readonly headNodeRole: cdk.aws_iam.Role;
    public readonly workerNodeRole: cdk.aws_iam.Role;
    constructor(scope: Construct, id: string, props: RayClusterProps) {
        super(scope, id);

        //grant cluster access to read from secrets manager
        const secretsManagerReadAccess = new cdk.aws_iam.PolicyStatement({
            actions: [
                'secretsmanager:GetSecretValue',
                'secretsmanager:DescribeSecret',
                'secretsmanager:ListSecrets',
            ],
            resources: ['*'],
            effect: cdk.aws_iam.Effect.ALLOW
        });

        //EC2 Role for Cluster head node full s3 and ssm coree
        const rayHeadNodeRole = new cdk.aws_iam.Role(this, 'RayHeadNodeRole', {
            assumedBy: new cdk.aws_iam.ServicePrincipal('ec2.amazonaws.com'),
            inlinePolicies: {
                'PassIAMRole': new cdk.aws_iam.PolicyDocument({
                    statements: [
                        new cdk.aws_iam.PolicyStatement({
                            actions: [
                                'iam:PassRole',
                            ],
                            resources: ['*'],
                            effect: cdk.aws_iam.Effect.ALLOW
                        })]
                })
            }
        });
        rayHeadNodeRole.addManagedPolicy(cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
        rayHeadNodeRole.addManagedPolicy(cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess'));
        rayHeadNodeRole.addManagedPolicy(cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2FullAccess'));
        rayHeadNodeRole.addManagedPolicy(cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AWSCloudFormationReadOnlyAccess'));
        rayHeadNodeRole.addManagedPolicy(cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchFullAccess'));
        rayHeadNodeRole.addToPolicy(secretsManagerReadAccess);

        //ec2 instance profile
        const rayHeadNodeInstanceProfile = new cdk.aws_iam.CfnInstanceProfile(this, 'RayHeadNodeInstanceProfile', {
            roles: [rayHeadNodeRole.roleName],
        });

        //EC2 Role for worker node full s3 and ssm coree
        const rayWorkerNodeRole = new cdk.aws_iam.Role(this, 'RayWorkerNodeRole', {
            assumedBy: new cdk.aws_iam.ServicePrincipal('ec2.amazonaws.com'),
        });
        rayWorkerNodeRole.addManagedPolicy(cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
        rayWorkerNodeRole.addManagedPolicy(cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess'));
        rayWorkerNodeRole.addManagedPolicy(cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AWSCloudFormationReadOnlyAccess'));
        rayWorkerNodeRole.addManagedPolicy(cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchFullAccess'));
        rayWorkerNodeRole.addToPolicy(secretsManagerReadAccess);

        //ec2 instance profile
        const rayWorkerNodeInstanceProfile = new cdk.aws_iam.CfnInstanceProfile(this, 'RayWorkerNodeInstanceProfile', {
            roles: [rayWorkerNodeRole.roleName],
        });

        //ec2 security group
        const raySecurityGroup = new ec2.SecurityGroup(this, 'RaySecurityGroup', {
            vpc: props.vpc,
            allowAllOutbound: true,
        });

        raySecurityGroup.connections.allowFrom(raySecurityGroup, ec2.Port.allTraffic())
        raySecurityGroup.connections.allowFrom(props.jumphost, ec2.Port.allTraffic())

        //read scripts
        var writeRayClusterFile = readFileSync('templates/writeRayClusterFile.sh', 'utf8')

        var ssmInputs = []
        ssmInputs.push(ssm.Input.ofTypeString('RayHeadNodeIamProfileArn', { defaultValue: rayHeadNodeInstanceProfile.attrArn })),
            ssmInputs.push(ssm.Input.ofTypeString('RayHeadNodeInstanceType', { defaultValue: 'g4dn.12xlarge' })),
            ssmInputs.push(ssm.Input.ofTypeString('RayHeadNodeResources', { defaultValue: '"CPU": 48, "GPU": 4' })),
            ssmInputs.push(ssm.Input.ofTypeString('RayWorkerNodeIamProfileArn', { defaultValue: rayWorkerNodeInstanceProfile.attrArn })),
            ssmInputs.push(ssm.Input.ofTypeString('RayWorkerNodeInstanceType', { defaultValue: 'g4dn.12xlarge' })),
            ssmInputs.push(ssm.Input.ofTypeString('RayWorkerNodeResources', { defaultValue: '"CPU": 48, "GPU": 4' })),
            ssmInputs.push(ssm.Input.ofTypeString('RayWorkerNodeMin', { defaultValue: '4' })),
            ssmInputs.push(ssm.Input.ofTypeString('RayWorkerNodeMax', { defaultValue: '4' })),
            ssmInputs.push(ssm.Input.ofTypeString('RaySecurityGroup', { defaultValue: raySecurityGroup.securityGroupId })),
            ssmInputs.push(ssm.Input.ofTypeString('RaySubnet1', { defaultValue: props.vpc.privateSubnets[0].subnetId })),
            ssmInputs.push(ssm.Input.ofTypeString('RaySubnet2', { defaultValue: props.vpc.privateSubnets[1].subnetId })),
            ssmInputs.push(ssm.Input.ofTypeString('RaySubnet3', { defaultValue: props.vpc.privateSubnets[2].subnetId })),
            ssmInputs.push(ssm.Input.ofTypeString('BucketName', { defaultValue: props.bucket.bucketName }))

        // Create Cluster Create Command Document
        const rayClusterCreateDoc = new ssm.CommandDocument(this, "RayClusterCreateDoc", {
            documentFormat: ssm.DocumentFormat.JSON,
            documentName: "CreateRayCluster",
            docInputs: ssmInputs,
        });

        const clusterSetupFiles = new ssm.RunShellScriptStep(this, "WriteRayClusterFile", {
            runCommand: [
                ssm.HardCodedString.of(writeRayClusterFile)
            ],
            name: "WriteRayClusterFile"
        })
        rayClusterCreateDoc.addStep(clusterSetupFiles)

        rayClusterCreateDoc.addStep(new ssm.RunShellScriptStep(this, "StartRayCluster", {
            runCommand: [ssm.HardCodedString.of("sudo ray up -y /rag/llm-batch-inference.yaml")],
            name: "StartRayCluster"
        }))

        rayClusterCreateDoc.addStep(new ssm.RunShellScriptStep(this, "ConfigureRayCluster", {
            runCommand: [
                ssm.HardCodedString.of("sudo -i"),
                ssm.HardCodedString.of("cd /rag"),
                ssm.HardCodedString.of("ray rsync_up llm-batch-inference.yaml 'embedding_ray_os.py' 'embedding_ray_os.py'"),
                ssm.HardCodedString.of("ray rsync_up llm-batch-inference.yaml 'query_os.py' 'query_os.py'"),
                ssm.HardCodedString.of("ray rsync_up llm-batch-inference.yaml 'embedding_ray_rds.py' 'embedding_ray_rds.py'"),
                ssm.HardCodedString.of("ray rsync_up llm-batch-inference.yaml 'query_rds.py' 'query_rds.py'"),
                ssm.HardCodedString.of("ray rsync_up llm-batch-inference.yaml 'requirements.txt' 'requirements.txt'"),
            ],
            name: "ConfigureRayCluster"
        }))

        rayClusterCreateDoc.addStep(new ssm.RunShellScriptStep(this, "CreateOpenSearchIndexes", {
            runCommand: [
                ssm.HardCodedString.of("sudo -i"),
                ssm.HardCodedString.of("cd /rag"),
                ssm.HardCodedString.of("python3 opensearchIndex.py"),
            ],
            name: "CreateOpenSearchIndexes"
        }))

        rayClusterCreateDoc.addStep(new ssm.RunShellScriptStep(this, "CreateRDSTables", {
            runCommand: [
                ssm.HardCodedString.of("sudo -i"),
                ssm.HardCodedString.of("cd /rag"),
                ssm.HardCodedString.of("python3 rds_setup.py"),
            ],
            name: "CreateRDSTables"
        }))

        //upload scripts_ray folder to the s3bucket
        const rayScriptsDeploy = new cdk.aws_s3_deployment.BucketDeployment(this, 'RayScripts', {
            sources: [cdk.aws_s3_deployment.Source.asset('scripts_ray/')],
            destinationBucket: props.bucket,
            destinationKeyPrefix: 'scripts_ray',
        })

        this.headNodeRole = rayHeadNodeRole;
        this.workerNodeRole = rayWorkerNodeRole;
        this.raySecurityGroup = raySecurityGroup
    }
}
