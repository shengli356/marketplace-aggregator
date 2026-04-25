/**
 * MarketplaceAggregatorStack
 *
 * Defines the full AWS infrastructure for the marketplace aggregator prototype.
 *
 * This stack provisions:
 * - DynamoDB for listings + activity feed
 * - SQS queues for async publish + event processing (with DLQs)
 * - Lambda functions for API, workers, and mock marketplace
 * - API Gateway HTTP API for external + internal endpoints
 * - Secrets Manager for HMAC signing
 * - S3 + CloudFront for hosting the frontend
 *
 * The design follows a serverless, event-driven architecture optimized for:
 * - low cost (pay-per-use services)
 * - async reliability (queues + retries + DLQs)
 * - security (IAM roles + signed webhooks + Basic Auth)
 */


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

    /**
     * DynamoDB table (single-table design)
     *
     * Stores:
     * - listings
     * - activity feed events (comments, sales, etc.)
     *
     * Uses pay-per-request for cost efficiency and TTL for cleanup.
     */
    const table = new dynamodb.Table(this, 'MarketplaceTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    /**
     * Shared HMAC signing secret
     *
     * Used to:
     * - sign internal publish requests
     * - sign mock marketplace webhook events
     * - verify incoming webhook authenticity
     */
    const signingSecret = new secretsmanager.Secret(this, 'MockWebhookSigningSecret', {
      description: 'Shared HMAC secret for the mock marketplace prototype',
      generateSecretString: {
        passwordLength: 48,
        excludePunctuation: true
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    const basicAuthSecret = new secretsmanager.Secret(this, 'BasicAuthSecret', {
      description: 'Basic auth credentials for API access',
      secretName: `${cdk.Stack.of(this).stackName}-BasicAuthSecret`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'demo' }),
        generateStringKey: 'password',
        passwordLength: 32,
        excludePunctuation: true
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    /**
     * Publish queue + DLQ
     *
     * Handles async listing publication with retry + failure isolation.
     */
    const publishDlq = new sqs.Queue(this, 'PublishDlq', {
      retentionPeriod: cdk.Duration.days(14)
    });
    const publishQueue = new sqs.Queue(this, 'PublishQueue', {
      visibilityTimeout: cdk.Duration.seconds(30),
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: { queue: publishDlq, maxReceiveCount: 4 }
    });

    /**
     * Mock event queue + DLQ
     *
     * Handles async mock marketplace webhook events with retry + failure isolation.
     */
    const mockEventDlq = new sqs.Queue(this, 'MockEventDlq', {
      retentionPeriod: cdk.Duration.days(14)
    });
    const mockEventQueue = new sqs.Queue(this, 'MockEventQueue', {
      visibilityTimeout: cdk.Duration.seconds(30),
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: { queue: mockEventDlq, maxReceiveCount: 4 }
    });

    /**
     * Common environment variables
     */
    const commonEnv = {
      TABLE_NAME: table.tableName,
      SIGNING_SECRET_ARN: signingSecret.secretArn,
      NODE_OPTIONS: '--enable-source-maps'
    };

    /**
     * Default Lambda configuration
     *
     * Optimized for:
     * - cost (ARM64)
     * - performance (Node 20)
     * - debuggability (source maps)
     */    
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

    /**
     * Main API Lambda
     *
     * Handles:
     * - creating listings
     * - fetching listings + activity
     * - receiving webhook events
     */    
    const apiFn = new lambdaNode.NodejsFunction(this, 'AppApiFunction', {
      ...fnDefaults,
      entry: path.join(__dirname, '../../services/api/src/index.ts'),
      environment: {
        ...commonEnv,
        PUBLISH_QUEUE_URL: publishQueue.queueUrl,
        BASIC_AUTH_SECRET_ARN: basicAuthSecret.secretArn
      }
    });

    /**
     * Publish worker Lambda
     *
     * Consumes publish queue and calls mock marketplace.
     */
    const publishWorkerFn = new lambdaNode.NodejsFunction(this, 'PublishWorkerFunction', {
      ...fnDefaults,
      entry: path.join(__dirname, '../../services/publish-worker/src/index.ts'),
      environment: {
        ...commonEnv
      }
    });

    const publishDlqHandlerFn = new lambdaNode.NodejsFunction(this, 'PublishDlqHandlerFunction', {
      ...fnDefaults,
      entry: path.join(__dirname, '../../services/publish-dlq-handler/src/index.ts'),
      environment: {
        ...commonEnv
      }
    });

    /**
     * Mock marketplace Lambda
     *
     * Simulates:
     * - async publish
     * - rate limiting / transient failures
     * - emitting events back into the system
     */
    const mockMarketplaceFn = new lambdaNode.NodejsFunction(this, 'MockMarketplaceFunction', {
      ...fnDefaults,
      entry: path.join(__dirname, '../../services/mock-marketplace/src/index.ts'),
      environment: {
        ...commonEnv,
        MOCK_EVENT_QUEUE_URL: mockEventQueue.queueUrl,
        SIMULATED_FAILURE_RATE: '0.30'
      }
    });

    /**
     * Mock event emitter Lambda
     *
     * Sends signed webhook events back into the system.
     */
    const mockEventEmitterFn = new lambdaNode.NodejsFunction(this, 'MockEventEmitterFunction', {
      ...fnDefaults,
      entry: path.join(__dirname, '../../services/mock-event-emitter/src/index.ts'),
      environment: {
        ...commonEnv
      }
    });

    /**
     * IAM permissions (least privilege via CDK grants)
     */
    table.grantReadWriteData(apiFn);
    table.grantReadWriteData(mockMarketplaceFn);
    table.grantReadWriteData(publishWorkerFn);
    table.grantReadWriteData(publishDlqHandlerFn);
    publishQueue.grantSendMessages(apiFn);
    mockEventQueue.grantSendMessages(mockMarketplaceFn);
    signingSecret.grantRead(apiFn);
    basicAuthSecret.grantRead(apiFn);
    signingSecret.grantRead(publishWorkerFn);
    signingSecret.grantRead(mockMarketplaceFn);
    signingSecret.grantRead(mockEventEmitterFn);

    /**
     * Connect queues to worker Lambdas
     */

    publishWorkerFn.addEventSource(new eventSources.SqsEventSource(publishQueue, {
      batchSize: 1,
      reportBatchItemFailures: true
    }));

    publishDlqHandlerFn.addEventSource(new eventSources.SqsEventSource(publishDlq, {
      batchSize: 1,
      reportBatchItemFailures: true
    }));
    mockEventEmitterFn.addEventSource(new eventSources.SqsEventSource(mockEventQueue, {
      batchSize: 1,
      reportBatchItemFailures: true
    }));

    /**
     * HTTP API Gateway (public entrypoint)
     */
    const httpApi = new apigwv2.HttpApi(this, 'MarketplaceHttpApi', {
      corsPreflight: {
        allowHeaders: [
          'authorization',
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

    /**
     * API integrations
     */
    const appIntegration = new integrations.HttpLambdaIntegration('AppIntegration', apiFn);
    const mockIntegration = new integrations.HttpLambdaIntegration('MockIntegration', mockMarketplaceFn);

    /**
     * API routes
     */    
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

    /**
     * Inject runtime URLs into workers
     */
    publishWorkerFn.addEnvironment('MOCK_PUBLISH_URL', `${httpApi.apiEndpoint}/mock-marketplace/publish`);
    mockEventEmitterFn.addEnvironment('WEBHOOK_URL', `${httpApi.apiEndpoint}/webhooks/mock-ebay`);

    /**
     * Frontend hosting (S3 + CloudFront)
     */    
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

    /**
     * Deploy frontend assets + inject API config
     */
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


    /**
     * Stack outputs (used after deployment)
     */
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
