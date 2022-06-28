#!/bin/bash

set -ex

#create array of folder patterns to compile
declare -a folders=("bin/*.js"
  "data_layer/*.js"
  "data_layer/**/*.js"
  "data_layer/**/**/*.js"
  "data_layer/**/**/**/*.js"
  "security/*.js"
  "security/data_objects/*.js"
  "server/*.js"
  "server/**/*.js"
  "server/**/**/*.js"
  "sqlTranslator/*.js"
  "upgrade/*.js"
  "upgrade/**/*.js"
  "upgrade/**/**/*.js"
  "utility/*.js"
  "utility/environment/*.js"
  "utility/functions/*.js"
  "utility/functions/**/*.js"
  "utility/install/*.js"
  "utility/lmdb/*.js"
  "utility/logging/*.js"
  "utility/registration/*.js"
  "utility/errors/*.js"
  "utility/AWS/*.js"
  "utility/pm2/*.js"
  "utility/scripts/*.js"
  "utility/clustering/*.js"
  "utility/terms/*.js"
  "validation/*.js"
  "validation/**/*.js"
  "config/*.js")

pwd
apt-get update && apt-get install -y build-essential jq sudo rsync

bytenode_version="$(jq -r ".dependencies.bytenode" package.json)"

npm install -g bytenode@$bytenode_version
npm install -g dot-json
npm install -g bundle-dependencies

go_version=$(jq -r '.engines."go-lang"' package.json)
echo $go_version

wget https://go.dev/dl/go${go_version}.linux-amd64.tar.gz
tar -C /usr/local -xzf go${go_version}.linux-amd64.tar.gz
rm -f go${go_version}.linux-amd64.tar.gz

export PATH=$PATH:/usr/local/go/bin
echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc
echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.profile

#verify dependencies are installed
go_version_installed="$(go version | cut -d ' ' -f 3 | cut -c 3-99)"
echo $go_version_installed

if ! [ "$go_version_installed" = "$go_version" ]; then
    echo "Go $go_version must be installed"
    exit
fi

node_version_installed="$(node -v)"
node_version="v$(npm run env | grep npm_package_engines_node | cut -d '=' -f 2)"
echo $node_version_installed

if ! [ "$node_version_installed" = "$node_version" ]; then
    echo "Node.js $node_version must be installed"
    exit
fi

if ! command -v jq &> /dev/null
then
  echo "jq must be installed, install jq using your OS package manager"
  exit
fi

bytenode_version_installed="$(bytenode -v | grep bytenode | cut -d ' ' -f 2)"

if ! [ "$bytenode_version_installed" = "$bytenode_version" ]
then
    echo "bytenode $bytenode_version must be installed, run command 'npm install bytenode@<version> -g'"
    exit
fi

if ! command -v dot-json &> /dev/null
then
  echo "dot-json must be installed, run command 'npm install dot-json -g'"
  exit
fi

if ! command -v bundle-dependencies &> /dev/null
then
  echo "bundle-dependencies must be installed, run command 'npm install bundle-dependencies -g'"
  exit
fi

#remove existing node_modules
rm -rf ./node_modules/

mkdir /root/.cache
export GOCACHE=/tmp/
chmod -R 777 /root/.npm/_logs
chown -R root ./
# npm install from source
# --silent sets npm log level to silent
# --production prevents install of dev dependencies

# NOTE: Make sure nats server binary doesn't get included in the tar.
npm --silent install --production
sleep 2

# Pull in custom_function_template repo
git submodule update --init --recursive

# Create package creation directory
rm -rf ./npm_pack/
mkdir ./npm_pack/

# Remove unnecessary portions of dependencies to decrease package size
rm -rf ./node_modules/socketcluster/sample/

# Move dependencies to package creation directory
mv ./node_modules/ ./npm_pack/

# Compile source to bytecode
for i in "${folders[@]}"
do
   bytenode --compile $i
done

# Copy code to package creation directory
rsync --include="*.jsc" --include="hdbCore.js" --include="harperdb.js" --include="hdb.js" --include="processCSV.worker.js" --exclude="*.js" --exclude=".*" --recursive ./ ./npm_pack/
rsync --exclude=".*" --recursive ./custom_function_template ./npm_pack/
rsync --recursive ./launchServiceScripts ./npm_pack/

# Reset names of entry point files
cp ./bin/harperdb_jsc.js ./npm_pack/bin/harperdb.js
unlink ./npm_pack/bin/harperdb_jsc.jsc

# Delete duplicate npm_pack directory from rsync
rm -rf npm_pack/npm_pack/

# Delete files that should be excluded from package
rm -rf ./npm_pack/utility/devops ./npm_pack/test ./npm_pack/unitTests ./npm_pack/integrationTests ./npm_pack/bash ./npm_pack/utility/Docker ./npm_pack/user_guide.html ./npm_pack/sonar-project.properties ./npm_pack/server/customFunctions/plugins/hdbCore.jsc

# Grab the postinstall script commands
post_install="$(jq -r '.scripts."postinstall"' package.json)"

# Delete scripts and devDependencies from ./npm_pack/package.json
dot-json ./npm_pack/package.json devDependencies --delete
dot-json ./npm_pack/package.json scripts --delete

# Create bundledDependencies in ./npm_pack/package.json
cd ./npm_pack/
bundle-dependencies update
# Add the postinstall script back
npm set-script postinstall "$post_install"
cd ../

# Move LICENSE file to ./license dir
mkdir ./npm_pack/license
mv ./npm_pack/LICENSE ./npm_pack/license

# Append README with commit ID
git rev-parse HEAD >> ./npm_pack/README.md

# Create package from package creation directory
npm --force pack ./npm_pack/