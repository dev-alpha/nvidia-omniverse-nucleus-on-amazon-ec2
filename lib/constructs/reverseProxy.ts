import { Construct } from 'constructs';
import { Stack, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { NagSuppressions } from 'cdk-nag';
import { CustomResource } from './common/customResource';
import { cleanEnv, bool, str } from 'envalid';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as pyLambda from '@aws-cdk/aws-lambda-python-alpha';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as dotenv from 'dotenv';

dotenv.config();
const env = cleanEnv(process.env, {
	ALLOWED_CIDR_RANGE_01: str({ default: '' }),
	ALLOWED_CIDR_RANGE_02: str({ default: '' }),
	DEV_MODE: bool({ default: false }),
	ROOT_DOMAIN: str({ default: '' }),
	NUCLEUS_SERVER_PREFIX: str({ default: 'nucleus' }),
});

export type ConstructProps = {
	vpc: ec2.Vpc;
	artifactsBucket: s3.IBucket;
	reverseProxySG: ec2.SecurityGroup;
	hostedZone: route53.IHostedZone;
	certificate: acm.Certificate;
	commonUtilsLambdaLayer: pyLambda.PythonLayerVersion;
	nucleusServerInstance: ec2.Instance;
};

export class RevProxyResources extends Construct {
	constructor(scope: Construct, id: string, props: ConstructProps) {
		super(scope, id);

		const region: string = Stack.of(this).region;
		const account: string = Stack.of(this).account;

		const root_domain = `${env.ROOT_DOMAIN}`;
		const fqdn = `${env.NUCLEUS_SERVER_PREFIX}.${env.ROOT_DOMAIN}`;

		const instance_role = new iam.Role(this, 'InstanceRole', {
			assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
			description: 'EC2 Instance Role',
			managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
		});

		// artifacts bucket
		instance_role.addToPolicy(
			new iam.PolicyStatement({
				resources: [`${props.artifactsBucket.bucketArn}`, `${props.artifactsBucket.bucketArn}/*`],
				actions: ['s3:ListBucket', 's3:GetObject'],
			})
		);
		instance_role.addToPolicy(
			new iam.PolicyStatement({
				actions: [
					'logs:CreateLogGroup',
					'logs:CreateLogStream',
					'logs:DescribeLogStreams',
					'logs:PutLogEvents',
				],
				resources: ['arn:aws:logs:*:*:log-group:/aws/ssm/*'],
			})
		);

		// AWS Certificate Manager for Nitro Enclaves AMI
		// ami id numbers periodically change, so we look up the ami by name prefix and owner
		const nitroImage = new ec2.LookupMachineImage({
			name: "ACM-For-Nitro-Enclaves-*",
			owners: ['aws-marketplace']
		});

		const ebs_volume: ec2.BlockDevice = {
			deviceName: '/dev/xvda',
			volume: ec2.BlockDeviceVolume.ebs(512, { encrypted: true }),
		};

		const launchTemplate = new ec2.LaunchTemplate(this, 'launchTemplate', {
			instanceType: new ec2.InstanceType('c5.xlarge'),
			machineImage: nitroImage,
			blockDevices: [ebs_volume],
			role: instance_role,
			securityGroup: props.reverseProxySG,
			nitroEnclaveEnabled: true,
			userData: ec2.UserData.forLinux(),
			detailedMonitoring: true,
		});

		const autoScalingGroup = new autoscaling.CfnAutoScalingGroup(this, 'autoScalingGroup', {
			maxSize: '1',
			minSize: '1',
			desiredCapacity: '1',
			launchTemplate: {
				version: launchTemplate.latestVersionNumber,
				launchTemplateId: launchTemplate.launchTemplateId,
			},
			vpcZoneIdentifier: props.vpc.selectSubnets({
				subnetGroupName: 'public-subnet-nat-gateway',
			}).subnetIds,
			healthCheckGracePeriod: 300,
		});

		const scaleUpLifecycleHook = new autoscaling.CfnLifecycleHook(this, 'scaleUpLifecycleHook', {
			autoScalingGroupName: autoScalingGroup.ref,
			lifecycleTransition: 'autoscaling:EC2_INSTANCE_LAUNCHING',
			defaultResult: 'ABANDON',
			heartbeatTimeout: 900,
		});

		const scaleDownLifecycleHook = new autoscaling.CfnLifecycleHook(
			this,
			'scaleDownLifecycleHook',
			{
				autoScalingGroupName: autoScalingGroup.ref,
				lifecycleTransition: 'autoscaling:EC2_INSTANCE_TERMINATING',
				defaultResult: 'ABANDON',
				heartbeatTimeout: 900,
			}
		);

		const lifecycleLambdaPolicy = new iam.PolicyDocument({
			statements: [
				new iam.PolicyStatement({
					resources: [
						`arn:aws:autoscaling:${region}:${account}:autoScalingGroup:*:autoScalingGroupName/${autoScalingGroup.ref}`,
						// `arn:aws:autoscaling:*:${account}:autoScalingGroup:*:autoScalingGroupName/${autoScalingGroup.ref}`,
					],
					actions: ['autoscaling:CompleteLifecycleAction'],
				}),
				new iam.PolicyStatement({
					resources: [
						`arn:aws:ssm:${region}::document/AWS-RunPowerShellScript`,
						`arn:aws:ssm:${region}::document/AWS-RunShellScript`,
						// `arn:aws:ssm:*::document/AWS-RunPowerShellScript`,
						// `arn:aws:ssm:*::document/AWS-RunShellScript`,
					],
					actions: ['ssm:SendCommand'],
				}),
				new iam.PolicyStatement({
					resources: ['arn:aws:ec2:*:*:instance/*'],
					actions: ['ssm:SendCommand'],
					conditions: {
						StringEquals: {
							'iam:ssm:ResourceTag/aws:autoscaling:groupName': autoScalingGroup.ref,
						},
					},
				}),
				new iam.PolicyStatement({
					resources: ['*'],
					actions: ['ssm:GetCommandInvocation'],
				}),
			],
		});

		const cnameLambdaPolicy = new iam.PolicyDocument({
			statements: [
				new iam.PolicyStatement({
					actions: ['route53:ChangeResourceRecordSets'],
					resources: [`${props.hostedZone.hostedZoneArn}`],
				}),
			],
		});

		const nginxConfigLambdaPolicy = new iam.PolicyDocument({
			statements: [
				new iam.PolicyStatement({
					actions: ['ssm:SendCommand'],
					resources: [`arn:aws:ec2:${region}:${account}:instance/*`],
					// resources: [`arn:aws:ec2:*:${account}:instance/*`],
				}),
				new iam.PolicyStatement({
					actions: ['ec2:DescribeInstances', 'ec2:DescribeInstanceStatus'],
					resources: [`*`],
				}),
				new iam.PolicyStatement({
					actions: ['ssm:SendCommand'],
					resources: ['arn:aws:ssm:*:*:document/*'],
				}),
				new iam.PolicyStatement({
					actions: ['ssm:GetCommandInvocation'],
					// resources: [`arn:aws:ssm:*:${account}:*`],
					resources: [`arn:aws:ssm:${region}:${account}:*`],
				}),
			],
		});

		const lifecycleLambdaRole = new iam.Role(this, 'lifecycleLambdaRole', {
			assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
			inlinePolicies: {
				lifecycleLambdaPolicy: lifecycleLambdaPolicy,
				cnameLambdaPolicy: cnameLambdaPolicy,
				nginxConfigLambdaPolicy: nginxConfigLambdaPolicy,
			},
		});

		const lambdaName = this.node.path.split('/').join('-') + '-lifecycleLambdaFn';
		const lambdaLogGroup = `/aws/lambda/${lambdaName}`;

		const logGroup = new logs.LogGroup(this, 'lifecycleLambdaFnLogGroup', {
			logGroupName: lambdaLogGroup,
			retention: logs.RetentionDays.ONE_WEEK,
			removalPolicy: RemovalPolicy.DESTROY,
		});

		const lifecycleLambdaFn = new pyLambda.PythonFunction(this, 'lifecycleLambdaFn', {
			functionName: lambdaName,
			runtime: lambda.Runtime.PYTHON_3_9,
			handler: 'handler',
			entry: './src/lambda/asgLifeCycleHooks/reverseProxy',
			role: lifecycleLambdaRole,
			timeout: Duration.minutes(15),
			layers: [props.commonUtilsLambdaLayer],
			environment: {
				R53_HOSTED_ZONE_ID: props.hostedZone.hostedZoneId,
				ARTIFACTS_BUCKET: props.artifactsBucket.bucketName,
				NUCLEUS_ROOT_DOMAIN: root_domain,
				NUCLEUS_DOMAIN_PREFIX: env.NUCLEUS_SERVER_PREFIX,
				NUCLEUS_SERVER_ADDRESS: props.nucleusServerInstance.instancePrivateDnsName,
				REVERSE_PROXY_SSL_CERT_ARN: props.certificate.certificateArn,
			},
		});
		lifecycleLambdaFn.node.addDependency(logGroup);

		lifecycleLambdaFn.addToRolePolicy(
			new iam.PolicyStatement({
				actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
				resources: [logGroup.logGroupArn],
			})
		);

		const rule = new events.Rule(this, 'rule', {
			eventPattern: {
				source: ['aws.autoscaling'],
				detailType: [
					'EC2 Instance-launch Lifecycle Action',
					'EC2 Instance-terminate Lifecycle Action',
				],
				detail: {
					AutoScalingGroupName: [autoScalingGroup.ref],
				},
			},
		});
		rule.node.addDependency(lifecycleLambdaFn);
		rule.addTarget(new targets.LambdaFunction(lifecycleLambdaFn));

		// --------------------------------------------------------------------
		// CUSTOM RESOURCE - Reverse Proxy Enclave Certificate Association
		// --------------------------------------------------------------------
		// the following is a custom resource for associating cert and the enclave instance role. This creates the association,
		// and then updates the role with permissions to access the cert bucket and encryption key.
		// For more information see https://docs.aws.amazon.com/enclaves/latest/user/nitro-enclave-refapp.html

		// create a policy with a dummy statement, this policy will be updated on the fly by the revProxyCertAssociationResource
		// we're creating a empty policy so we can just inject a statement at runtime, less overhead in the custom resource logic
		const revProxyCertAssociationPolicy = new iam.ManagedPolicy(
			this,
			'revProxyCertAssociationPolicy',
			{
				statements: [
					new iam.PolicyStatement({
						actions: ['iam:GetRole'],
						resources: ['*'],
					}),
				],
			}
		);
		instance_role.addManagedPolicy(revProxyCertAssociationPolicy);

		const certAssociationLambdaPolicy = new iam.PolicyDocument({
			statements: [
				new iam.PolicyStatement({
					actions: [
						'iam:GetPolicyVersion',
						'iam:GetPolicy',
						'iam:CreatePolicyVersion',
						'iam:DeletePolicyVersion',
						'iam:SetDefaultPolicyVersion',
					],
					resources: [revProxyCertAssociationPolicy.managedPolicyArn],
				}),
				new iam.PolicyStatement({
					actions: [
						'ec2:AssociateEnclaveCertificateIamRole',
						'ec2:GetAssociatedEnclaveCertificateIamRoles',
						'ec2:DisassociateEnclaveCertificateIamRole',
					],
					resources: [
						`arn:aws:acm:${region}:${account}:certificate/*`,
						// `arn:aws:acm:*:${account}:certificate/*`,
						`arn:aws:iam::${account}:role/*`,
					],
				}),
			],
		});

		const certAssociationResource = new CustomResource(this, 'certAssociationResource', {
			lambdaCodePath: './src/lambda/customResources/reverseProxyCertAssociation',
			lambdaPolicyDocument: certAssociationLambdaPolicy,
			resourceProps: {
				certArn: props.certificate.certificateArn,
				roleArn: instance_role.roleArn,
				rolePolicy: revProxyCertAssociationPolicy.managedPolicyArn,
				nounce: 2,
			},
		});

		NagSuppressions.addResourceSuppressions(
			instance_role,
			[
				{
					id: 'AwsSolutions-IAM5',
					reason:
						'Wildcard Permissions: Unable to know which objects exist ahead of time. Need to use wildcard',
				},
			],
			true
		);
		NagSuppressions.addResourceSuppressions(
			lifecycleLambdaRole,
			[
				{
					id: 'AwsSolutions-IAM5',
					reason:
						'Wildcard Permissions: This is a Dummy Policy with minimal actions. This policy is updated on the fly by the revProxyCertAssociation custom resource',
				},
			],
			true
		);

		NagSuppressions.addResourceSuppressions(
			autoScalingGroup,
			[
				{
					id: 'AwsSolutions-AS3',
					reason:
						'Autoscaling Event notifications: Backlogged, will provide guidance in production document',
				},
			],
			true
		);

		NagSuppressions.addResourceSuppressions(
			revProxyCertAssociationPolicy,
			[
				{
					id: 'AwsSolutions-IAM5',
					reason:
						'Wildcard Permissions: Unable to know which instance exists ahead of time. Need to use wildcard',
				},
			],
			true
		);
	}
}
