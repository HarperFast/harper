NODE_VERSION = $(shell node --version | cut -c2-)
HDB_VERSION = $(shell jq -r .version ../../package.json)
WARNING = "The docker images created with this file are not suitable for publishing, so please don't do that."

USER_HOME = ${HOME}
HDB_DIRECTORY_PREFIX = $(USER_HOME)/tmp/hdb

build-images: build-image-standard build-image-openshift build-image-fabric
run-build-standard: build-harperdb build-image-standard run-standard
run-build-openshift: build-harperdb build-image-openshift run-openshift
run-build-fabric: build-harperdb build-image-fabric run-fabric
clean-images: clean-image-standard clean-image-openshift clean-image-fabric
clean-images-and-dirs: clean-image-directory-standard clean-image-directory-openshift clean-image-directory-fabric

build-harperdb:
	@( test -f ../../harperdb-$(HDB_VERSION).tgz || ( echo "building harperdb $(HDB_VERSION)" && cd ../.. && utility/devops/build/build.sh  )) || exit
	@echo "harperdb-$(HDB_VERSION).tgz found, copying to current dir" && cp ../../harperdb-$(HDB_VERSION).tgz harperdb-$(HDB_VERSION).tgz

build-harperdb-force:
	@cd ../.. && utility/devops/build/build.sh
	@cp ../../harperdb-$(HDB_VERSION).tgz harperdb-$(HDB_VERSION).tgz

generate-fake-licenses:
	@mkdir -p utility/Docker/licenses
	@touch utility/Docker/licenses/not-for-distribrution

build-image-standard: build-harperdb generate-fake-licenses
	docker buildx build \
		--build-arg NODE_VERSION=$(NODE_VERSION) \
		--build-arg HARPERDB_TARBALL=harperdb-$(HDB_VERSION).tgz \
		--build-arg HARPERDB_VERSION=$(HDB_VERSION) \
		--build-arg VCS_REF=`git rev-parse HEAD` \
		--build-arg BUILD_DATE=`date -u +%FT%T` \
		--progress auto \
		--output=type=docker \
		--file Dockerfile \
		--tag harperdb/harperdb:${HDB_VERSION} .
	@echo $(WARNING)

build-image-openshift: build-harperdb generate-fake-licenses
	docker buildx build \
		--build-arg NODE_VERSION=$(NODE_VERSION) \
		--build-arg HARPERDB_TARBALL=harperdb-$(HDB_VERSION).tgz \
		--build-arg HARPERDB_VERSION=$(HDB_VERSION) \
		--build-arg VCS_REF=`git rev-parse HEAD` \
		--build-arg BUILD_DATE=`date -u +%FT%T` \
		--progress auto \
		--output=type=docker \
		--file Dockerfile-openshift \
		--tag harperdb/harperdb-openshift:${HDB_VERSION} .
	@echo $(WARNING)

build-image-fabric: build-harperdb generate-fake-licenses
	docker buildx build \
		--build-arg NODE_VERSION=$(NODE_VERSION) \
		--build-arg HARPERDB_TARBALL=harperdb-$(HDB_VERSION).tgz \
		--build-arg HARPERDB_VERSION=$(HDB_VERSION) \
		--build-arg VCS_REF=`git rev-parse HEAD` \
		--build-arg BUILD_DATE=`date -u +%FT%T` \
		--progress auto \
		--output=type=docker \
		--file Dockerfile-fabric \
		--tag harperdb/harperdb-fabric:${HDB_VERSION} .
	@echo $(WARNING)

run-standard: clean-image-standard
	docker rm -f harperdb-standard
	docker run -d \
		-v $(HDB_DIRECTORY_PREFIX)-standard:/home/harperdb/hdb \
        -e HDB_ADMIN_USERNAME=HDB_ADMIN \
		-e HDB_ADMIN_PASSWORD=password \
		-e HARPERDB_FINGERPRINT="4sADRM2e7dd501d7db58bb02d35bd0745146423a1" \
		-e HARPERDB_LICENSE='{"license_key":"1373969b4cabd39e8b29c3c16e419c6abef4437d48168b4721e575610dcf656cf57016bd037cf1107f8232a1e94b7352c05b7c069560ac0e54ca156d3babc966289c664e5fb163e3429158a2f57afd39854ca51fa885abbca62f7e063a334498cd5ef0a038cbea80c6e063d174bbcc189a81dc4f2771ad90c9022cf20a322043ec4213fdef1d1e9eba36117c865acb6a13be3be218513ee80385e78bda0b9e27e7ec6532ac6e5416bc020f4f4be91cf6mofi25eYMW6aiRf6bd3d9b691699749569f6acd34a93e61","company":"harperdb.io"}' \
		-p 9925:9925 \
		-p 9926:9926 \
		-p 9932:9932 \
		--name harperdb-standard \
		harperdb/harperdb:${HDB_VERSION}

run-openshift: clean-image-openshift
	docker run -d \
		-v $(HDB_DIRECTORY_PREFIX)-openshift:/home/harperdb/hdb \
        -e HDB_ADMIN_USERNAME=HDB_ADMIN \
		-e HDB_ADMIN_PASSWORD=password \
		-e HARPERDB_FINGERPRINT="4sADRM2e7dd501d7db58bb02d35bd0745146423a1" \
		-e HARPERDB_LICENSE='{"license_key":"1373969b4cabd39e8b29c3c16e419c6abef4437d48168b4721e575610dcf656cf57016bd037cf1107f8232a1e94b7352c05b7c069560ac0e54ca156d3babc966289c664e5fb163e3429158a2f57afd39854ca51fa885abbca62f7e063a334498cd5ef0a038cbea80c6e063d174bbcc189a81dc4f2771ad90c9022cf20a322043ec4213fdef1d1e9eba36117c865acb6a13be3be218513ee80385e78bda0b9e27e7ec6532ac6e5416bc020f4f4be91cf6mofi25eYMW6aiRf6bd3d9b691699749569f6acd34a93e61","company":"harperdb.io"}' \
		-p 9925:9925 \
		-p 9926:9926 \
		-p 9932:9932 \
		--name harperdb-openshift \
		harperdb/harperdb-openshift:${HDB_VERSION}

run-fabric: clean-image-fabric
	docker run -d \
		-v $(HDB_DIRECTORY_PREFIX)-fabric:/home/harperdb/hdb \
		-e HDB_ADMIN_USERNAME=HDB_ADMIN \
		-e HDB_ADMIN_PASSWORD=password \
		-e HARPERDB_FINGERPRINT="4sADRM2e7dd501d7db58bb02d35bd0745146423a1" \
		-e HARPERDB_LICENSE='{"license_key":"1373969b4cabd39e8b29c3c16e419c6abef4437d48168b4721e575610dcf656cf57016bd037cf1107f8232a1e94b7352c05b7c069560ac0e54ca156d3babc966289c664e5fb163e3429158a2f57afd39854ca51fa885abbca62f7e063a334498cd5ef0a038cbea80c6e063d174bbcc189a81dc4f2771ad90c9022cf20a322043ec4213fdef1d1e9eba36117c865acb6a13be3be218513ee80385e78bda0b9e27e7ec6532ac6e5416bc020f4f4be91cf6mofi25eYMW6aiRf6bd3d9b691699749569f6acd34a93e61","company":"harperdb.io"}' \
		-p 9925:9925 \
		-p 9926:9926 \
		-p 9932:9932 \
		--name harperdb-fabric \
		harperdb/harperdb-fabric:${HDB_VERSION}

get-versions:
	@echo "HDB_VERSION  = $(HDB_VERSION)"
	@echo "NODE_VERSION = $(NODE_VERSION)"

clean-image-standard:
	docker rm -f harperdb-standard

clean-image-openshift:
	docker rm -f harperdb-openshift

clean-image-fabric:
	docker rm -f harperdb-fabric

clean-image-directory-standard: clean-image-standard
	rm -rf $(HDB_DIRECTORY_PREFIX)-standard/*

clean-image-directory-openshift: clean-image-openshift
	rm -rf $(HDB_DIRECTORY_PREFIX)-openshift/*

clean-image-directory-fabric: clean-image-fabric
	rm -rf $(HDB_DIRECTORY_PREFIX)-fabric/*

clean: clean-images-and-dirs
	rm harperdb-$(HDB_VERSION).tgz ../../harperdb-$(HDB_VERSION).tgz
	rm -r utility