#!/bin/bash



init()
{
echo "Abc1234!" | apt-get -S update

#Repo Dependencies. ADDED BUILDX Dependency qemu
sudo apt-get install -y \
    apt-transport-https \
    ca-certificates \
    curl \
    gnupg-agent \
    software-properties-common \
    qemu-user-static \
    jq
	
#INSTALL REPO prerequisites and repo config
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo apt-key add -

sudo apt-key fingerprint 0EBFCD88

sudo add-apt-repository \
   "deb [arch=amd64] https://download.docker.com/linux/ubuntu \
   $(lsb_release -cs) \
   stable"
#Update and install docker    
   sudo apt-get update
   
   sudo apt-get install -y docker-ce docker-ce-cli containerd.io
   #POST INSTALL add user to docker group
#sudo groupadd docker
   
sudo usermod -aG docker ubuntu
touch ./creds
echo "bxrxwduhtmvmw" > ./creds
cat ./creds | sudo docker login -u zacharyhdb --password-stdin
  # zacharyhdb
  # bxrxwduhtmvmw
   
 # update config.json
 #vi /home/ubuntu/.docker/config.json

sudo chown -R ubuntu:ubuntu /home/ubuntu/
cat /home/ubuntu/.docker/config.json | jq '. + {"experimental":"enabled"}' | tee config.json
mv -f ./config.json /home/ubuntu/.docker/config.json

#QEMU STUFF
#https://github.com/multiarch/qemu-user-static#getting-started
#SOMETHIGN IS WRONG WITH THIS: docker run --rm --privileged docker/binfmt:820fdd95a9972a5308930a2bdfb8573dd4447ad && \
sudo su ubuntu -c "docker run --rm --privileged multiarch/qemu-user-static --reset -p yes && \
	docker buildx create --name deploy && \
	docker buildx use deploy && \
	docker buildx inspect --bootstrap"

#docker buildx build -f Dockerfile --tag harperdb/hdb:latest --platform="linux/amd64,linux/armv8" .
exit 0
}

find_the_artifact()
{
#The Artifacts Directory for this particular buildInstacne HarperDB20:DevelopmentObfuscationandTest
artifactHome="/home/ubuntu/data_dir/.BuildServer/system/artifacts/HarperDB20/DevelopmentObfuscationandTest/"
#find the path to the newest artifact from a build
artifactDir=$(ls -tl "$artifactHome" | sed -n '2p' | awk '{print $9}')

fullPath="$artifactHome""$artifactDir"
artifact=$(ls "$fullPath"  | grep -m 1 harperdb-*)
pathToTGZ="$fullPath/$artifact"
echo "The artifact lives here: $pathToTGZ"

if [ -e "$pathToTGZ" ]; then
      echo "File exists Move it and use it"
      cp $pathToTGZ ./
   else
      echo "File Is not there ABORT"
      exit 1
fi


}

production(){

#find newest build
find_the_artifact

docker buildx build --tag harperdb/hdb:latest -f Dockerfile --load .
#test it runs
dockerTest=$(docker run harperdb/hdb /usr/local/bin/harperdb version)
if [ -z "$dockerTest" ]; then
       echo "Something is terribly wrong"
   else
    echo "*******Data*********: $dockerTest "
    echo "******** END ********"
fi

#push
#docker push harperdb/hdb:latest
exit 0
}

development(){
# Where is .tgz
# Create .tgz
# docker buildx build --tag harperdb/testing:latest -f Dockerfile --load
# test it runs
#push to private repo
exit 0
}

$@
