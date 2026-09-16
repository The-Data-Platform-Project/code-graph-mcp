terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "eu-west-1"
}

resource "aws_db_instance" "shop" {
  identifier     = "shop-prod"
  engine         = "postgres"
  instance_class = "db.t4g.medium"
}

resource "aws_s3_bucket" "invoices" {
  bucket = "acme-shop-invoices"
}

resource "aws_sqs_queue" "order_events" {
  name = "shop-order-events"
}
