#!/bin/sh
set -eu

mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc mb --ignore-existing "local/$S3_QUARANTINE_BUCKET"
mc mb --ignore-existing "local/$S3_CLEAN_BUCKET"
mc anonymous set none "local/$S3_QUARANTINE_BUCKET"
mc anonymous set none "local/$S3_CLEAN_BUCKET"

# The mc image contains only the client binary and cat. Generate the policy
# without relying on non-portable text substitution tools.
cat > /tmp/ici-document-storage.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::$S3_QUARANTINE_BUCKET",
        "arn:aws:s3:::$S3_CLEAN_BUCKET"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::$S3_QUARANTINE_BUCKET/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::$S3_CLEAN_BUCKET/*"
    }
  ]
}
EOF

mc admin user add local "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY"
mc admin policy create local ici-document-storage /tmp/ici-document-storage.json
mc admin policy attach local ici-document-storage --user "$S3_ACCESS_KEY_ID"
