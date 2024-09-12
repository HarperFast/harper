# HarperDB Build and Release Process

DevOps process for release.

## Table of Contents

<!-- TOC -->

- [HarperDB Build and Release Process](#harperdb-build-and-release-process)
  - [Table of Contents](#table-of-contents)
  - [Pre-Flight Checklist](#pre-flight-checklist)
  - [Pre-Production Release](#pre-production-release)
    - [Build Package](#build-package)
      - [Tests](#tests)
    - [Cloud AMIs](#cloud-amis)
      - [Build and Release](#build-and-release)
      - [Verification](#verification)
    - [NPM Private Release](#npm-private-release)
      - [Publish Restricted NPM Package](#publish-restricted-npm-package-)
    - [Private Docker Hub Release](#private-docker-hub-release)
  - [Prod Release](#prod-release)
  _ [release-on-tag.yaml workflow](#release-on-tagyaml-workflow)
  _ [Publish Public NPM Package](#publish-public-npm-package)
  _ [Publishing a GA release version:](#publishing-a-ga-release-version)
  _ [Publishing an alpha/beta/RC version:](#publishing-an-alphabetarc-version)
  _ [Docker Hub Release](#docker-hub-release)
  _ [Redhat Container Image Release](#redhat-container-image-release)
  _ [pre-requisites](#pre-requisites)
  _ [process](#process)
  _ [Update DigitalOcean Marketplace](#update-digitalocean-marketplace)
  _ [Update Offline Install Package](#update-offline-install-package)
  _ [PROD HarperDB Cloud](#prod-harperdb-cloud)
  _ [Upgrade](#upgrade)
  <!-- TOC -->

## Pre-Flight Checklist

- [ ] Ensure `package.json` is up to date with new HarperDB version, and any other needed changes
- [ ] Ensure `README.md` is up to date
- [ ] Ensure `utility/Docker/README.md` is up to date
- [ ] Ensure `utility/Docker/Dockerfile*` are up to date
- [ ] Ensure any edits done in the release branch/tag to the above files, are also done in main, if appropriate
- [ ] Review documentation and release notes for needed changes, and sync with development to make sure docs are updated alongside release
  - development is responsible for documentation, however, look out for any updates that are more devops oriented and provide input as needed
- [ ] Open Source license notices

[Marketing logos](https://drive.google.com/drive/u/2/folders/1-ZO1yuBsskfohFiFZKLl9k0FFbIqntkk)
are on Google Drive (`Google Drive > Go-to-Market > Design/Brand Files > HDB Logos`)

## Pre-Production Release

### Build Package

#### Tests

Verify with development that appropriate tests have completed successfully on release tag.

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
3. Test instances. _Testing should be better defined here_
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
> Select the following drop-down options on the `npm publish` workflow:

- select appropriate release branch or tag
- `private` to choose publishing to the private/restricted npm repo
- choose the mutable tag assigned to this publication, either `next` or `latest+stable` as appropriate
- `false` on whether we should use the `--dry-run` flag to test this process

1. Verify package was published at [@harperdb/harperdb](https://www.npmjs.com/package/@harperdb/harperdb)
2. Verify tags and version at [@harperdb/harperdb](https://www.npmjs.com/package/@harperdb/harperdb)

### Private Docker Hub Release

Docker Hub allows publishing a new image with tags that match tags of an already published image, so no need to practice
by publishing to the private repository first.

1. Run the `DockerHub Publish Public`
   ([dockerhub-publish-private.yaml](https://github.com/HarperDB/harperdb/blob/main/.github/workflows/dockerhub-publish-private.yaml))
   workflow against the release branch/tag.
2. Test locally using examples in [README.md](utility/Docker/README.md)

## Prod Release

### release-on-tag.yaml workflow

This workflow runs anytime a tag is pushed to the 'HarperDB/harperdb' repository matching the pattern: `release_*`, or it is launched directly by a user ('workflow_dispatch').
The workflow will fail if the tag does not further match the following pattern, even if called manually (through 'workflow_dispatch'):

```
release_<version>[-<alpha|beta|rc>.<prerelease-version>]
```

such as

```
release_4.3.0-beta.16
 - or -
release_4.3.0
```

Updates to the status of the workflow run will be posted to the `#development-ci` channel.

This workflow covers the following in the prod release context:

- Publish Public NPM Package
  - both GA or alpha/beta/rc based on the tag
- Docker Hub Release
  - both GA or alpha/beta/rc based on the tag
- Redhat Container Image Release
  - only GA releases based on tag. We still need to manually publish at [Redhat Connect](https://connect.redhat.com/projects/64652bdb6c16c68a7fdbe93b/images) until we set that to `auto-publish`

The following sections are if you wish to manually handle a release without using tags or for steps not yet fully automated (such as [Update DigitalOcean Marketplace](#update-digitalocean-marketplace)).

#### Publish Public NPM Package

Run the `npm Publish Public`
([npm-publish-public.yaml](https://github.com/HarperDB/harperdb/blob/main/.github/workflows/npm-publish-public.yaml))
workflow against the release branch/tag

> Setting `dry-run` to `true` as an input does everything publish would do except actually publishing to the registry

##### Publishing a GA release version:

Select the following drop-down options on the `npm publish` workflow:

- select appropriate release branch or tag
- `public` to choose publishing to the public npm repo
- `latest+stable` as the mutable tag assigned to this publication
- `false` on whether we should use the `--dry-run` flag to test this process

Verify tags and deprecated version at [harperdb/harperdb](https://www.npmjs.com/package/harperdb/harperdb)

##### Publishing an alpha/beta/RC version:

Select the following drop-down options on the `npm publish` workflow:

- select appropriate release branch or tag
- `public` to choose publishing to the public npm repo
- `next` as the mutable tag assigned to this publication
- `false` on whether we should use the `--dry-run` flag to test this process

Verify tags and deprecated version at [harperdb/harperdb](https://www.npmjs.com/package/harperdb/harperdb)

#### Docker Hub Release

Docker Hub allows publishing a new image with tags that match tags of an already published image, so no need to practice
by publishing to the private repository first.

> This will publish both `harperdb/harperdb` and `harperdb/harperdb-openshift`.

1. Run the `DockerHub Publish Public`
   ([dockerhub-publish-public.yaml](https://github.com/HarperDB/harperdb/blob/main/.github/workflows/dockerhub-publish-public.yaml))
   workflow against the release branch/tag.
2. Verify README and new version under tags at [harperdb/harperdb](https://hub.docker.com/r/harperdb/harperdb)
3. Test locally using examples in [README.md](utility/Docker/README.md)
4. Update the Dockerhub Readme to match `README.md` in `utility/Docker`

### Redhat Container Image Release

The above step will publish the `harperdb/harperdb-openshift` image to Dockerhub. From here, we need to submit it to
Redhat for certification.

This should be rolled up into the `release_on_tag.yaml` workflow soon.

#### pre-requisites

1. podman (or [podman-desktop](https://podman-desktop.io/)) - you can installed this next to docker-desktop. This is needed to generate a docker auth file for Redhat.
2. [openshift-preflight](https://github.com/redhat-openshift-ecosystem/openshift-preflight) - you will have to compile and install this, unless you happen to be running RHEL.

#### process

If you have not already created one, create an auth file for dockerhub. Redhat needs this due to dockerhub pull restrictions.
This command will create an auth file `temp-auth.json` in the current directory.

```shell
podman login registry.hub.docker.com --authfile ./temp-auth.json
```

Next is to push these images to Redhat. You will want to `docker pull` the image first. You will need to have built the `openshift-preflight` utility from above.
They `pyxis` key can be found in LastPass under the redhat.com harperdb account entry in the notes.

> You no longer have to run this for each platform. Running without the `--platform` option will push the manifest from the docker registry

```shell
preflight check container registry.hub.docker.com/harperdb/harperdb-openshift:[version] \
  --submit \
  --pyxis-api-token=${PYXIS_API_TOKEN} \
  --certification-project-id=64652bdb6c16c68a7fdbe93b \
  --docker-config ./temp-auth.json
```

After this, you will need to go here [HarperDB Container Image Project](https://connect.redhat.com/projects/64652bdb6c16c68a7fdbe93b/images)
and publish/unpublish images as needed.

### Update DigitalOcean Marketplace

> NOTE: the `digitalocean-create-snapshot.yaml` workflow referenced here only works with versions of HarperDB that have been published to [www.npmjs.com/package/harperdb](https://www.npmjs.com/package/harperdb)

1. Run the `DigitalOcean Create Snapshot` workflow ([digitalocean-create-snapshot.yaml](https://github.com/HarperDB/harperdb/blob/main/.github/workflows/digitalocean-create-snapshot.yaml))
   1. You will need to supply both `harperdbVersion` and `nodeVersion` for this step.
2. Goto [digital ocean images](https://cloud.digitalocean.com/images/snapshots/droplets) and locate the newly created snapshot after the workflow has completed
3. Click on the `More` dropdown for the snapshot, and select `Update Marketplace 1-Click App`
4. Update the information, especially the version, and submit

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
