import * as cdk from 'aws-cdk-lib';
import { aws_ec2 as ec2 } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { OpenSearch } from './openSearch';
import { JumpHost } from './jumphost';
import * as glue from '@aws-cdk/aws-glue-alpha'
import { Role } from 'aws-cdk-lib/aws-iam';
import { RayCluster } from './rayCluster';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import { S3Code } from 'aws-cdk-lib/aws-lambda';

export interface RagStackProps extends cdk.StackProps {
  includeRDS: boolean;
  includeOpenSearch: boolean;
}

export class RAGStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: RagStackProps) {
    super(scope, id, props);

    //vpc
    let numNatGw = this.node.tryGetContext('numNatGw');
    if (numNatGw === undefined) {
      numNatGw = 3;
    }
    const vpc = new ec2.Vpc(this, 'VPC', {
      natGateways: numNatGw
    });

    //s3bucket
    const s3Bucket = new cdk.aws_s3.Bucket(this, 'S3Bucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    //JumpHost
    const jumpHost = new JumpHost(this, 'Jumphost', {
      vpc: vpc
    })

    // Glue

    //Glue Role with full access to s3
    const glueRole = new Role(this, 'GlueRole', {
      assumedBy: new cdk.aws_iam.ServicePrincipal('glue.amazonaws.com'),
    })

    glueRole.addManagedPolicy(cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess'));
    glueRole.addManagedPolicy(cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AWSCloudFormationReadOnlyAccess'));

    //Glue Job
    const glueJob = new glue.Job(this, 'GlueJob', {
      jobName: 'oscar-jsonl-parquet',
      executable: glue.JobExecutable.pythonEtl({
        glueVersion: glue.GlueVersion.V4_0,
        pythonVersion: glue.PythonVersion.THREE,
        script: new glue.AssetCode('templates/spark-jsonl-parquet.py')
      }),
      role: glueRole,
      workerType: glue.WorkerType.G_8X,
      workerCount: 50
    })

    //Ray Cluster
    const rayClusterSetup = new RayCluster(this, 'RayClusterSetup', {
      vpc: vpc,
      jumphost: jumpHost.instance,
      bucket: s3Bucket
    })

    //OpenSearch 
    if (props?.includeOpenSearch) {

      const ragOpenSearch = new OpenSearch(this, 'OpenSearch', { vpc: vpc, domainName: 'genai' })

      ragOpenSearch.openSearchDomain.connections.allowFrom(jumpHost.instance, ec2.Port.allTraffic(), 'All traffic from jumphost to OpenSearch')
      ragOpenSearch.openSearchDomain.connections.allowFrom(rayClusterSetup.raySecurityGroup, ec2.Port.allTraffic(), 'All traffic from ray to OpenSearch')

      ragOpenSearch.openSearchDomain.grantIndexReadWrite("*", rayClusterSetup.headNodeRole)
      ragOpenSearch.openSearchDomain.grantIndexReadWrite("*", rayClusterSetup.workerNodeRole)
      ragOpenSearch.openSearchDomain.grantIndexReadWrite("*", jumpHost.instance.role)
      ragOpenSearch.openSearchDomain.grantPathReadWrite("*", rayClusterSetup.headNodeRole)
      ragOpenSearch.openSearchDomain.grantPathReadWrite("*", rayClusterSetup.workerNodeRole)
      ragOpenSearch.openSearchDomain.grantPathReadWrite("*", jumpHost.instance.role)
      ragOpenSearch.openSearchDomain.grantReadWrite(rayClusterSetup.headNodeRole)
      ragOpenSearch.openSearchDomain.grantReadWrite(rayClusterSetup.workerNodeRole)
      ragOpenSearch.openSearchDomain.grantReadWrite(jumpHost.instance.role)

      new cdk.CfnOutput(this, 'opensearchUrl', {
        description: "Access OpenSearch via this URL.",
        value: "https://" + ragOpenSearch.openSearchDomain.domainEndpoint,
        exportName: 'opensearchUrl'
      });

    }

    if (props?.includeRDS) {
      //RDS Postgres Instance
      const ragPostgres = new cdk.aws_rds.DatabaseInstance(this, 'RDSPostgres', {
        engine: cdk.aws_rds.DatabaseInstanceEngine.postgres({ version: cdk.aws_rds.PostgresEngineVersion.VER_15_2 }),
        vpc: vpc,
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.R7G, ec2.InstanceSize.XLARGE12),
        allocatedStorage: 20000,
        multiAz: true,
        storageEncrypted: true,
        enablePerformanceInsights: true,
        performanceInsightRetention: 7,

      })

      //grant jumphost and ray clusters access to postgres
      ragPostgres.connections.allowDefaultPortFrom(jumpHost.instance)
      ragPostgres.connections.allowDefaultPortFrom(rayClusterSetup.raySecurityGroup)

      new cdk.CfnOutput(this, 'rdsEndpoint', {
        value: ragPostgres.dbInstanceEndpointAddress,
        description: "RDS Endpoint",
        exportName: 'rdsEndpoint'
      })
  
      var rdsSecretARN = 'undefined'
      if (ragPostgres.secret) {
        rdsSecretARN = ragPostgres.secret?.secretArn
      }
      new cdk.CfnOutput(this, 'rdsSecretARN', {
        value: rdsSecretARN,
        description: "Secret ARN for RDS",
        exportName: 'rdsSecretARN'
      })
    }

    // Cloudwatch dashboard
    const dashboard = new cw.Dashboard(this, 'Dashboard', {
      defaultInterval: cdk.Duration.days(7),
      dashboardName: "RAG_Benchmarks"
    });
    dashboard.addWidgets(new cw.GraphWidget({
      title: "[Opensearch] Average ingest time for 100 records",
      left: [new cw.Metric({
        metricName: "ingesttime",
        namespace: "RAG",
        dimensionsMap: {
          vectordb: "opensearch"
        }
      })],
    }));
    dashboard.addWidgets(new cw.GraphWidget({
      title: "[Opensearch] P99 ingest time for 100 records",
      left: [new cw.Metric({
        metricName: "ingesttime",
        namespace: "RAG",
        statistic: "p99",
        dimensionsMap: {
          vectordb: "opensearch"
        }
      })],
    }));
    dashboard.addWidgets(new cw.SingleValueWidget({
      title: "[Opensearch] Number of 100-record batches ingested",
      metrics: [new cw.Metric({
        metricName: "ingesttime",
        namespace: "RAG",
        statistic: "SampleCount",
        dimensionsMap: {
          vectordb: "opensearch"
        }
      })],
    }));
    dashboard.addWidgets(new cw.GraphWidget({
      title: "[Opensearch] Average query time",
      left: [new cw.Metric({
        metricName: "querytime",
        namespace: "RAG",
        dimensionsMap: {
          vectordb: "opensearch"
        }
      })],
    }));
    dashboard.addWidgets(new cw.GraphWidget({
      title: "[Opensearch] P99 query time",
      left: [new cw.Metric({
        metricName: "querytime",
        namespace: "RAG",
        statistic: "p99",
        dimensionsMap: {
          vectordb: "opensearch"
        }
      })],
    }));
    dashboard.addWidgets(new cw.GraphWidget({
      title: "[RDS] Average ingest time for 100 records",
      left: [new cw.Metric({
        metricName: "ingesttime",
        namespace: "RAG",
        dimensionsMap: {
          vectordb: "rds"
        }
      })],
    }));
    dashboard.addWidgets(new cw.GraphWidget({
      title: "[RDS] P99 ingest time for 100 records",
      left: [new cw.Metric({
        metricName: "ingesttime",
        namespace: "RAG",
        statistic: "p99",
        dimensionsMap: {
          vectordb: "rds"
        }
      })],
    }));
    dashboard.addWidgets(new cw.SingleValueWidget({
      title: "[RDS] Number of 100-record batches ingested",
      metrics: [new cw.Metric({
        metricName: "ingesttime",
        namespace: "RAG",
        statistic: "SampleCount",
        dimensionsMap: {
          vectordb: "rds"
        }
      })],
    }));
    dashboard.addWidgets(new cw.GraphWidget({
      title: "[RDS] Average query time",
      left: [new cw.Metric({
        metricName: "querytime",
        namespace: "RAG",
        dimensionsMap: {
          vectordb: "rds"
        }
      })],
    }));
    dashboard.addWidgets(new cw.GraphWidget({
      title: "[RDS] P99 query time",
      left: [new cw.Metric({
        metricName: "querytime",
        namespace: "RAG",
        statistic: "p99",
        dimensionsMap: {
          vectordb: "rds"
        }
      })],
    }));


    //CDK Outputs
    new cdk.CfnOutput(this, 'bucketName', {
      value: s3Bucket.bucketName,
      description: "S3 Bucket for files",
      exportName: 'bucketName'
    })
  }
}
