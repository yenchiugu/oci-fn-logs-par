# OCI Functions Log PAR Generator

An Oracle Cloud Infrastructure (OCI) Functions service that generates Pre-Authenticated Requests (PARs) for secure log file uploads from Android applications to OCI Object Storage.

## Features

- Generates secure, time-limited URLs for Object Storage uploads
- Supports multiple deployment environments (internal, staging, production)
- Compatible with OCI Functions, Instance Principals, and local development
- Built-in self-testing and environment diagnostics
- Automatic authentication fallback mechanisms

## Architecture

This function creates `ObjectWrite` PARs that allow Android clients to upload log files directly to OCI Object Storage without exposing sensitive credentials to the mobile application.

### File Organization
Log files are organized with the following structure:
```
logs/{environment}/{appVersion}/{userId}/{timestamp}-{uuid}.zip
```

## Prerequisites

- Node.js 20.x
- Oracle Cloud Infrastructure account
- OCI Object Storage bucket
- Appropriate IAM policies for Functions service

## Local Development

### Setup

1. Install dependencies:
```bash
npm install
```

2. Configure OCI credentials:
   - Set up `~/.oci/config` file with your credentials
   - Or use environment variables for Instance Principals

3. Set environment variables:
```bash
export OCI_REGION=ap-tokyo-1
export BUCKET=my-internal-logs
export DEFAULT_TTL_SEC=900
```

### Local Testing

Generate a PAR for testing:
```bash
npm run local:presign
```

With custom parameters:
```bash
npm run local:presign:win
```

## Deployment to OCI Functions

### Deploy Function

1. Deploy the function:
```bash
npm run deploy
```

2. Configure function environment:
```bash
npm run config:func
```

### Test Deployed Function

Environment dump (check configuration):
```bash
npm run remote:envdump
```

Self-test (verify connectivity):
```bash
npm run remote:selftest
```

Generate PAR on deployed function:
```bash
npm run remote:presign
```

## API

### Generate PAR

**Request:**
```json
{
  "userId": "user123",
  "appVersion": "1.2.3",
  "env": "internal"
}
```

**Response:**
```json
{
  "url": "https://objectstorage.region.oraclecloud.com/p/...",
  "key": "logs/internal/1.2.3/user123/1703123456789-uuid.zip",
  "expiresAt": "2023-12-21T12:00:00.000Z"
}
```

### Environment Diagnostics

**Request:**
```json
{
  "mode": "envdump"
}
```

**Response:**
```json
{
  "present": {
    "OCI_RESOURCE_PRINCIPAL_VERSION": true,
    "OCI_RESOURCE_PRINCIPAL_REGION": true,
    ...
  },
  "files": {
    "rpstOk": true,
    "pemPathOk": true
  }
}
```

### Self Test

**Request:**
```json
{
  "mode": "selftest"
}
```

**Response:**
```json
{
  "ok": true,
  "namespace": "your-namespace",
  "bucket": "my-internal-logs",
  "region": "ap-tokyo-1",
  "rp": {...}
}
```

## Configuration

### Environment Variables

- `BUCKET` - Object Storage bucket name
- `DEFAULT_TTL_SEC` - PAR expiration time in seconds (default: 900)
- `OCI_REGION` - OCI region identifier
- `OCI_CONFIG_FILE` - Custom OCI config file path (local development)
- `OCI_PROFILE` - OCI config profile name (local development)

### IAM Policies

The function requires the following OCI IAM policies:

```
Allow service FaaS to manage objects in compartment <compartment-name> where target.bucket.name='<bucket-name>'
Allow service FaaS to inspect buckets in compartment <compartment-name>
Allow service FaaS to manage preauthenticated-requests in compartment <compartment-name> where target.bucket.name='<bucket-name>'
```

## Error Handling

The function includes comprehensive error handling with:

- Resource Principal authentication fallback
- Instance Principal authentication fallback
- Local development configuration support
- Detailed error logging and reporting
- Safe environment variable exposure (no sensitive data)

## Security Features

- Time-limited PAR URLs (configurable expiration)
- Object-specific write permissions only
- No credential exposure to client applications
- Unique file paths prevent overwrites
- Environment-based access control

## License

Apache License 2.0

## Development

### File Structure

- `func.js` - Main function code with authentication and PAR generation
- `func.yaml` - OCI Functions configuration
- `package.json` - Node.js dependencies and scripts
- `.gitignore` - Git ignore patterns

### Testing

The function supports multiple testing modes:
- Local CLI testing with custom parameters
- Remote function testing with environment diagnostics
- Self-test mode for connectivity verification
