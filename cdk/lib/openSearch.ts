import * as cdk from 'aws-cdk-lib';
import { aws_opensearchservice as opensearch } from 'aws-cdk-lib';
import { Construct } from 'constructs';

interface OpenSearchProps {
  vpc: cdk.aws_ec2.Vpc;
  domainName: string;
}


export class OpenSearch extends Construct {
  public readonly openSearchDomain: opensearch.Domain;

  constructor(scope: Construct, id: string, props: OpenSearchProps) {
    super(scope, id);

    //Opensearch
    this.openSearchDomain = new opensearch.Domain(this, 'openSearch-Domain', {
      domainName: props.domainName,
      version: opensearch.EngineVersion.OPENSEARCH_2_5,
      enableVersionUpgrade: true,
      vpc: props.vpc,
      ebs: {
        enabled: true,
        volumeSize: 300
      },
      zoneAwareness: {
        availabilityZoneCount: 3
      },
      capacity: {
        dataNodes: 21,
        dataNodeInstanceType: "r6g.4xlarge.search",
        masterNodes: 3,
        masterNodeInstanceType: "r6g.4xlarge.search"
      },
      accessPolicies: [
        new cdk.aws_iam.PolicyStatement({
          actions: ['es:*',],
          resources: ['*'],
          effect: cdk.aws_iam.Effect.ALLOW,
          principals: [new cdk.aws_iam.AnyPrincipal()]
        })],
        removalPolicy: cdk.RemovalPolicy.DESTROY
    })
  }
}
