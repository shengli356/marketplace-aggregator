import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as eventSources from 'aws-cdk-lib/aws-lambda-event-sources';

export class MarketplaceAggregatorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const table = new dynamodb.Table(this, 'MarketplaceTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    const signingSecret = new secretsmanager.Secret(this, 'MockWebhookSigningSecret', {
      description: 'Shared HMAC secret for the mock marketplace prototype',
      generateSecretString: {
        passwordLength: 48,
        excludePunctuation: true
      }
    });

    const publishDlq = new sqs.Queue(this, 'PublishDlq', {
      retentionPeriod: cdk.Duration.days(14)
    });
    const publishQueue = new sqs.Queue(this, 'PublishQueue', {
      visibilityTimeout: cdk.Duration.seconds(45),
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: { queue: publishDlq, maxReceiveCount: 4 }
    });

    const mockEventDlq = new sqs.Queue(this, 'MockEventDlq', {
      retentionPeriod: cdk.Duration.days(14)
    });
    const mockEventQueue = new sqs.Queue(this, 'MockEventQueue', {
      visibilityTimeout: cdk.Duration.seconds(45),
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: { queue: mockEventDlq, maxReceiveCount: 4 }
    });

    const commonEnv = {
      TABLE_NAME: table.tableName,
      SIGNING_SECRET_ARN: signingSecret.secretArn,
      NODE_OPTIONS: '--enable-source-maps'
    };

    const fnDefaults = {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(15),
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: []
      }
    } satisfies Partial<lambdaNode.NodejsFunctionProps>;

    const apiFn = new lambdaNode.NodejsFunction(this, 'AppApiFunction', {
      ...fnDefaults,
      entry: path.join(__dirname, '../../services/api/src/index.ts'),
      environment: {
        ...commonEnv,
        PUBLISH_QUEUE_URL: publishQueue.queueUrl
      }
    });

    const publishWorkerFn = new lambdaNode.NodejsFunction(this, 'PublishWorkerFunction', {
      ...fnDefaults,
      entry: path.join(__dirname, '../../services/publish-worker/src/index.ts'),
      environment: {
        ...commonEnv
      }
    });

    const mockMarketplaceFn = new lambdaNode.NodejsFunction(this, 'MockMarketplaceFunction', {
      ...fnDefaults,
      entry: path.join(__dirname, '../../services/mock-marketplace/src/index.ts'),
      environment: {
        ...commonEnv,
        MOCK_EVENT_QUEUE_URL: mockEventQueue.queueUrl,
        SIMULATED_FAILURE_RATE: '0.15'
      }
    });

    const mockEventEmitterFn = new lambdaNode.NodejsFunction(this, 'MockEventEmitterFunction', {
      ...fnDefaults,
      entry: path.join(__dirname, '../../services/mock-event-emitter/src/index.ts'),
      environment: {
        ...commonEnv
      }
    });

    table.grantReadWriteData(apiFn);
    table.grantReadWriteData(mockMarketplaceFn);
    table.grantReadWriteData(publishWorkerFn);
    publishQueue.grantSendMessages(apiFn);
    mockEventQueue.grantSendMessages(mockMarketplaceFn);
    signingSecret.grantRead(apiFn);
    signingSecret.grantRead(publishWorkerFn);
    signingSecret.grantRead(mockMarketplaceFn);
    signingSecret.grantRead(mockEventEmitterFn);

    publishWorkerFn.addEventSource(new eventSources.SqsEventSource(publishQueue, {
      batchSize: 1,
      reportBatchItemFailures: true
    }));
    mockEventEmitterFn.addEventSource(new eventSources.SqsEventSource(mockEventQueue, {
      batchSize: 1,
      reportBatchItemFailures: true
    }));

    const httpApi = new apigwv2.HttpApi(this, 'MarketplaceHttpApi', {
      corsPreflight: {
        allowHeaders: [
          'content-type',
          'x-mock-signature',
          'x-mock-timestamp',
          'x-internal-signature',
          'x-internal-timestamp'
        ],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.OPTIONS
        ],
        allowOrigins: ['*'],
        maxAge: cdk.Duration.days(1)
      }
    });

    const appIntegration = new integrations.HttpLambdaIntegration('AppIntegration', apiFn);
    const mockIntegration = new integrations.HttpLambdaIntegration('MockIntegration', mockMarketplaceFn);

    httpApi.addRoutes({
      path: '/listings',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: appIntegration
    });
    httpApi.addRoutes({
      path: '/webhooks/mock-ebay',
      methods: [apigwv2.HttpMethod.POST],
      integration: appIntegration
    });
    httpApi.addRoutes({
      path: '/mock-marketplace/publish',
      methods: [apigwv2.HttpMethod.POST],
      integration: mockIntegration
    });
    httpApi.addRoutes({
      path: '/mock-marketplace/events',
      methods: [apigwv2.HttpMethod.POST],
      integration: mockIntegration
    });

    publishWorkerFn.addEnvironment('MOCK_PUBLISH_URL', `${httpApi.apiEndpoint}/mock-marketplace/publish`);
    mockEventEmitterFn.addEnvironment('WEBHOOK_URL', `${httpApi.apiEndpoint}/webhooks/mock-ebay`);

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: new origins.S3Origin(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS
      },
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' }
      ]
    });

    new s3deploy.BucketDeployment(this, 'DeployFrontend', {
      sources: [
        s3deploy.Source.asset(path.join(__dirname, '../../frontend/dist')),
        s3deploy.Source.jsonData('config.json', {
          apiBaseUrl: httpApi.apiEndpoint
        })
      ],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*']
    });

    new cdk.CfnOutput(this, 'SiteUrl', {
      value: `https://${distribution.distributionDomainName}`
    });
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: httpApi.apiEndpoint
    });
    new cdk.CfnOutput(this, 'PublishDlqUrl', {
      value: publishDlq.queueUrl
    });
    new cdk.CfnOutput(this, 'MockEventDlqUrl', {
      value: mockEventDlq.queueUrl
    });
  }
}
