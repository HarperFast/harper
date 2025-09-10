# GitHub Actions

## build.yaml

### Description

This workflow is for building the harperdb tar for all "Build Package" tests.

This workflow uses the "version" in package.json to create the tar name and the "engines.node" value to build the tar in an appropriate `node:*-bullseye` container.

### Trigger

This workflow is triggered by other workflows that use it

### Inputs

N/A

### Outputs

1. nodeVersion
2. harperdbVersion

### Artifacts

1. harperdb-\<version\>.tar

### Uses

N/A

---

## create-instances.yaml

### Description

This workflow is for running the terraform required to create all necessary instances for the tests to run.

### Trigger

This workflow is triggered by other workflows that use it

### Inputs

1. instanceCount - How many instances to create
   - Required
2. instanceType - AWS instance type for all instances
   - Default: "c5.2xlarge"
3. volumeSize - Volume size to attach to all instances
   - Default: "32"
4. harperdbVersion
   - Required
5. installType - Used to determine if tar should be uploaded to instances
   - Default: "buildPackage"
6. harperdb-\<version\>.tgz
   - If using a "buildPackage" install type there must be an artifact as a part of a previous job containing the harperdb tar

### Outputs

1. publicDnsNames - Array of public DNS names of created instances
2. publicIps - Array of public IPs of created instances

### Artifacts

1. tfstate

### Uses

N/A

---

## destroy-instances.yaml

### Description

This workflow is for cleaning up the instances from `create-instances.yaml`. Workflows consuming this should always have an `if: always()` to ensure instances are cleaned up, even if there are errors on other steps.

### Trigger

This workflow is triggered by other workflows that use it

### Inputs

1. instanceCount - How many instances to create
   - Required
2. instanceType - AWS instance type for all instances
   - Default: "c5.2xlarge"
3. volumeSize - Volume size to attach to all instances
   - Default: "32"
4. harperdbVersion
   - Required
5. installType - Used to determine if tar should be uploaded to instances
   - Default: "buildPackage"
6. tfstate artifact
   - Uses the tfstate artifact produced by `create-instances.yaml`

### Outputs

N/A

### Artifacts

N/A

### Uses

N/A

---

## install-harper.yaml

### Description

This workflow is for installing Harper on every instance for the tests

### Trigger

This workflow is triggered by other workflows that use it

### Inputs

1. publicDns - Array public dns names of instances to install hdb on
   - Required
2. harperdbVersion - Version number of install
   - Required
3. nodeVersion - Node version from `package.json`
   - Required
4. installType - "buildPackage" or "sourceCode"
   - Default: "buildPackage"

### Outputs

N/A

### Artifacts

N/A

### Uses

N/A

---

## download-logs.yaml

### Description

This workflow downloads all relevant logs from all instances used during testing

### Trigger

This workflow is triggered by other workflows that use it

### Inputs

1. publicDns - Array public dns names of instances to download logs from

### Outputs

N/A

### Artifacts

1. logs
   - HDB Logs for each instance
   - HDB Config file for each instance
   - Newman reports

### Uses

N/A

---

## source-code-ci-test.yaml

### Description

This workflow runs the source code unit tests, CI tests, and Sonar Scans on a single instance

### Trigger

This workflow is triggered when PR is opened or a commit is made to a branch with an open PR.

### Inputs

N/A

### Outputs

N/A

### Artifacts

N/A

### Uses

1. create-instances
2. install-harper
3. download-logs
4. destroy-instances

---

## build-package-ci-test.yaml

### Description

This workflow runs the CI tests on a single instance against a built package of harperdb

### Trigger

This workflow is triggered when PR is opened or a commit is made to a branch with an open PR.

### Inputs

N/A

### Outputs

N/A

### Artifacts

N/A

### Uses

1. build
2. create-instances
3. install-harper
4. download-logs
5. destroy-instances

---

## build-package-cluster-test-b.yaml

### Description

This workflow runs the Cluster Test B suite of tests against a built package of harperdb on 4 instances

### Trigger

This workflow is triggered every weekday at midnight and can be manually triggered to run against any branch

### Inputs

N/A

### Outputs

N/A

### Artifacts

N/A

### Uses

1. build
2. create-instances
3. install-harper
4. download-logs
5. destroy-instances
