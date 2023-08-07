import * as cdk from 'aws-cdk-lib';
import { aws_ec2 as ec2 } from 'aws-cdk-lib';
import { readFileSync } from 'fs';
import { Construct } from 'constructs';

interface JumpHostProps {
    vpc: cdk.aws_ec2.Vpc;
}

export class JumpHost extends Construct {
    public readonly instance: ec2.Instance;

    constructor(scope: Construct, id: string, props: JumpHostProps) {
        super(scope, id);

        //ec2 security group
        const jumpHostSecurityGroup = new ec2.SecurityGroup(this, 'JumpHostSecurityGroup', {
            vpc: props.vpc,
            allowAllOutbound: true,
        });

        // jumps host role. has permission to s3, ef3 and ssmcore
        const jumpHostRole = new cdk.aws_iam.Role(this, 'JumpHostRole', {
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
        jumpHostRole.addManagedPolicy(cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
        jumpHostRole.addManagedPolicy(cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess'));
        jumpHostRole.addManagedPolicy(cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2FullAccess'));
        jumpHostRole.addManagedPolicy(cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AWSCloudFormationReadOnlyAccess'));
        jumpHostRole.addManagedPolicy(cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonOpenSearchServiceFullAccess'));
        jumpHostRole.addManagedPolicy(cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchFullAccess'));
        jumpHostRole.addManagedPolicy(cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonKendraFullAccess'));

        //grant jump host access to read from secrets manager
        const secretsManagerReadAccess = new cdk.aws_iam.PolicyStatement({
            actions: [
                'secretsmanager:GetSecretValue',
                'secretsmanager:DescribeSecret',
                'secretsmanager:ListSecrets',
            ],
            resources: ['*'],
            effect: cdk.aws_iam.Effect.ALLOW
        });
        jumpHostRole.addToPolicy(secretsManagerReadAccess);


        //ec2 instance profile
        const jumpHostRoleInstanceProfile = new cdk.aws_iam.CfnInstanceProfile(this, 'JumpHostRoleInstanceProfile', {
            roles: [jumpHostRole.roleName],
        });

        //read templates/jumphostUserData.sh file
        var jumpsHostUserData = readFileSync('templates/jumphostUserData.sh', 'utf8');

        //ec2 instance
        this.instance = new ec2.Instance(this, 'jumpHostEC2Instance', {
            vpc: props.vpc,
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.M5N, ec2.InstanceSize.XLARGE4),
            machineImage: ec2.MachineImage.fromSsmParameter('/aws/service/canonical/ubuntu/server/focal/stable/current/amd64/hvm/ebs-gp2/ami-id'),
            securityGroup: jumpHostSecurityGroup,
            role: jumpHostRole,
            blockDevices: [
                {
                    deviceName: '/dev/sda1',
                    volume: ec2.BlockDeviceVolume.ebs(10000, {
                        encrypted: true,
                        deleteOnTermination: true,
                        volumeType: ec2.EbsDeviceVolumeType.IO2,
                        iops: 64000
                    }),
                }
            ],
        })

        this.instance.addUserData(jumpsHostUserData);
    }
}

