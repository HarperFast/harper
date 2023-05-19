# HarperDB Build and Release Process

## Table of Contents

<!-- TOC -->
* [HarperDB Build and Release Process](#harperdb-build-and-release-process)
  * [Table of Contents](#table-of-contents)
  * [Pre-Flight Checklist](#pre-flight-checklist)
  * [Pre-Production Release](#pre-production-release)
    * [Build Package](#build-package)
      * [CI Tests](#ci-tests)
      * [Cluster CI Tests](#cluster-ci-tests)
    * [Docker Image](#docker-image)
      * [CI Tests](#ci-tests-1)
      * [Cluster CI Tests](#cluster-ci-tests-1)
    * [Cloud AMIs](#cloud-amis)
      * [Build and Release](#build-and-release)
      * [Verification](#verification)
    * [NPM Private Release](#npm-private-release)
      * [Publish Restricted NPM Package](#publish-restricted-npm-package)
    * [Private Docker Hub Release](#private-docker-hub-release)
  * [Prod Release](#prod-release)
    * [Publish Public NPM Package](#publish-public-npm-package)
      * [Publishing a non-alpha/beta/RC version:](#publishing-a-non-alphabetarc-version)
      * [Publishing an alpha/beta/RC version:](#publishing-an-alphabetarc-version)
    * [Docker Hub Release](#docker-hub-release)
    * [Update Offline Install Package](#update-offline-install-package)
    * [PROD HarperDB Cloud](#prod-harperdb-cloud)
      * [Upgrade](#upgrade)
<!-- TOC -->

## Pre-Flight Checklist

 - [ ] Ensure `package.json` is up to date with new HarperDB version, and any other needed changes
 - [ ] Ensure `README.md` is up to date
 - [ ] Ensure `utility/Docker/README.md` is up to date
 - [ ] Ensure `utility/Docker/Dockerfile` is up to date
 - [ ] Ensure any edits done in the release branch/tag to the above files, are also done in main, if appropriate
 - [ ] Review documentation for changes that may be needed. In particular:
   - [ ] [https://docs.harperdb.io/docs/install-harperdb](https://docs.harperdb.io/docs/install-harperdb)
   - [ ] [https://docs.harperdb.io/docs/install-harperdb/linux](https://docs.harperdb.io/docs/install-harperdb/linux)
   - [ ] Create PR for [HarperDB/documentation](https://github.com/HarperDB/documentation) if needed
- [ ] Remind/coordinate with developers that they may need to update the following:
    - [ ] Release notes
    - [ ] Documentation updates
    - [ ] Open Source license notices 

[Marketing logos](https://drive.google.com/drive/u/2/folders/1-ZO1yuBsskfohFiFZKLl9k0FFbIqntkk)
are on Google Drive (`Google Drive > HarperDB Corporate Drive > Brand & Marketing > HDB Logos`)

## Pre-Production Release

### Build Package

#### CI Tests

Ensure the `Run Build Package CI Tests` workflow 
([build-package-ci-test.yaml](https://github.com/HarperDB/harperdb/blob/main/.github/workflows/build-package-ci-test.yaml))
has completed successfully against the release branch/tag.

> Note: this workflow is currently run automatically on PR, changes to `main`, and on a schedule for `main`

#### Cluster CI Tests

Verify the following workflows have completed successfully against the release branch/tag:

- [runBuildPackageClusterTestA](https://github.com/HarperDB/harperdb/blob/main/.github/workflows/build-package-cluster-test-a.yaml)
- [runBuildPackageClusterTestB](https://github.com/HarperDB/harperdb/blob/main/.github/workflows/build-package-cluster-test-b.yaml)
- [runBuildPackageClusterTestC](https://github.com/HarperDB/harperdb/blob/main/.github/workflows/build-package-cluster-test-c.yaml)

Test are defined [here](https://github.com/HarperDB/harperdb/tree/main/integrationTests/clusterTests)
Logs are downloaded as artifacts, and a message is posted to `#development` in slack.

> Note: these workflows are set to also run on PR, changes to `main`, and on a schedule for `main`

### Docker Image

#### CI Tests

Verify the `Run Docker CI Tests` workflow
([docker-ci-tests.yaml](https://github.com/HarperDB/harperdb/blob/main/.github/workflows/docker-ci-tests.yaml))
has completed successfully against the release branch/tag.

> Note: this workflow is currently run automatically on PR and on a schedule

#### Cluster CI Tests

Verify the following workflows have completed successfully against the release branch/tag:

- [runDockerClusterTestA](https://github.com/HarperDB/harperdb/blob/main/.github/workflows/docker-cluster-test-a.yaml)
- [runDockerClusterTestB](https://github.com/HarperDB/harperdb/blob/main/.github/workflows/docker-cluster-test-b.yaml)
- [runDockerClusterTestC](https://github.com/HarperDB/harperdb/blob/main/.github/workflows/docker-cluster-test-c.yaml)

Tests are defined [here](https://github.com/HarperDB/harperdb/tree/main/integrationTests/clusterTests)
Logs are downloaded as artifacts, and a message is posted to `#development` in slack.

> Note: these workflows are set to run on PR and on a schedule for `main`.

### Cloud AMIs

#### Build and Release

Run the `HarperDB Cloud AMI Create` workflow 
([harperdb-cloud-ami.yaml](https://github.com/HarperDB/harperdb/blob/main/.github/workflows/harperdb-cloud-ami.yaml))
against the release branch/tag.

This workflow uses inline steps to create AMIs for both standard, and wavelength zones using
[packer](https://packer.io). This workflow will also build the harperdb package.

Update dev configuration in 
[hdb_cloud_services_config](https://github.com/HarperDB/hdb_cloud_services_config/)
to reflect new AMIs under 
[cloudFormationTemplates/dev](https://github.com/HarperDB/hdb_cloud_services_config/tree/master/cloudFormationTemplates/dev)

Push these CloudFormation templates to s3:
```shell
aws s3 cp HarperDB-Cloud-compute-stack_dev.yaml s3://hdb-cloud-config/cloudformation-templates/dev/HarperDB-Cloud-compute-stack_dev.yaml 
aws s3 cp HarperDB-Cloud-compute-stack-wl_dev.yaml s3://hdb-cloud-config/cloudformation-templates/dev/HarperDB-Cloud-compute-stack-wl_dev.yaml
```

#### Verification

1. Go to [stage-studio](https://stage.studio.harperdb.io) and deploy instances in each region
   including Wavelength zones.
2. Verify all instances launched properly and are running the new version. 
3. Test instances. *Testing should be better defined here*
4. Notify team.

### NPM Private Release

NPM does not allow publishing a package as a version that already exists on NPM, so it’s a 
good idea to first publish a new version of our restricted package and verify your work 
before publishing a new version of our public package.

#### Publish Restricted NPM Package

Run the `npm Publish Private` 
([npm-publish-private.yaml](https://github.com/HarperDB/harperdb/blob/main/.github/workflows/npm-publish-private.yaml))
workflow against the release branch/tag

> Setting `dry-run` to `true` as an input does everything publish would do except actually publishing to the registry

1. Verify package was published at [@harperdb/harperdb](https://www.npmjs.com/package/@harperdb/harperdb) 
2. Verify tags and version at 
   [@harperdb/harperdb](https://www.npmjs.com/package/@harperdb/harperdb)

### Private Docker Hub Release

Docker Hub allows publishing a new image with tags that match tags of an already published image, so no need to practice
by publishing to the private repository first.

1. Run the `DockerHub Publish Public`
   ([dockerhub-publish-private.yaml](https://github.com/HarperDB/harperdb/blob/main/.github/workflows/dockerhub-publish-private.yaml))
   workflow against the release branch/tag.
2. Test locally using examples in [README.md](utility/Docker/README.md)

## Prod Release

### Publish Public NPM Package

Run the `npm Publish Public`
([npm-publish-public.yaml](https://github.com/HarperDB/harperdb/blob/main/.github/workflows/npm-publish-public.yaml))
workflow against the release branch/tag

> Setting `dry-run` to `true` as an input does everything publish would do except actually publishing to the registry

#### Publishing a non-alpha/beta/RC version:

1. Verify package was published at [harperdb/harperdb](https://www.npmjs.com/package/harperdb/harperdb)
2. Add `stable` tag to new package
   ```shell 
   npm dist-tag add harperdb/harperdb@<new version> stable
   ```
3. Deprecate old package version
   ```shell
   npm deprecate harperdb/harperdb@<old version> "Please use the latest stable version of HarperDB"
   ```
4. Verify tags and deprecated version at
   [harperdb/harperdb](https://www.npmjs.com/package/harperdb/harperdb)

#### Publishing an alpha/beta/RC version:

1. Verify package was published at [harperdb/harperdb](https://www.npmjs.com/package/harperdb/harperdb)
2. Move `latest` tag back to the version that had previously had the tag
   ```shell
   npm dist-tag add harperdb/harperdb@<old version> latest
   ```
3. Do not move `stable` tag
4. Deprecate any older alpha/beta/RC versions
   ```shell
   npm deprecate harperdb/harperdb@<old alpha/beta/RC version> "Please use the latest stable version of HarperDB"
   ```
5. Verify tags and deprecated version at
   [harperdb/harperdb](https://www.npmjs.com/package/harperdb/harperdb)

### Docker Hub Release

Docker Hub allows publishing a new image with tags that match tags of an already published image, so no need to practice 
by publishing to the private repository first.

1. Run the `DockerHub Publish Public` 
([dockerhub-publish-public.yaml](https://github.com/HarperDB/harperdb/blob/main/.github/workflows/dockerhub-publish-public.yaml))
workflow against the release branch/tag.
2. Verify README and new version under tags at [harperdb/harperdb](https://hub.docker.com/r/harperdb/harperdb)
3. Test locally using examples in [README.md](utility/Docker/README.md)
4. Update the Dockerhub Readme to match `README.md` in `utility/Docker`

### Update Offline Install Package

1. Run the `Build Offline Install Package` workflow ([all-in-one-build.yaml](https://github.com/HarperDB/harperdb/blob/main/.github/workflows/all-in-one-build.yaml))
2. Verify [install-harperdb#offline-install](https://docs.harperdb.io/docs/install-harperdb#offline-install) has been updated
   [in this s3 bucket](https://products-harperdb-io.s3.us-east-2.amazonaws.com/index.html)
3. Verify that the following link works: `https://products-harperdb-io.s3.us-east-2.amazonaws.com/latest/harperdb-<version>.tgz`

### PROD HarperDB Cloud

Update 
[hdb_cloud_services_config](https://github.com/HarperDB/hdb_cloud_services_config/)
to reflect new AMIs under 
[cloudFormationTemplates/prod](https://github.com/HarperDB/hdb_cloud_services_config/tree/master/cloudFormationTemplates/prod)

#### Upgrade

Upgrade existing HarperDB Cloud instances using 
[HarperDB Cloud Instance Upgrade and Patching Process](https://paper.dropbox.com/doc/JF6hsUNn5RY9JHbRa8CDj)

> TODO: Review above doc for `4.x` upgrade process