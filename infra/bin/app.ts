#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { MarketplaceAggregatorStack } from '../lib/marketplace-stack';

const app = new cdk.App();

new MarketplaceAggregatorStack(app, 'MarketplaceAggregatorStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1'
  }
});
