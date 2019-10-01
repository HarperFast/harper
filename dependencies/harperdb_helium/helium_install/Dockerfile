FROM centos:centos7
MAINTAINER Shahram Emadi

USER root

# install dev tools
RUN yum update; \
    yum install -y gcc deltapm net-tools; \
    yum install -y openssh-server openssh-clients psmisc rsync passwd; \
    yum install -y libevent; \
    yum clean all;

# Install Helium
ADD install*linux*.sh /
RUN /install*linux*.sh
RUN helium --version

# Entry point only
ENTRYPOINT helium --server --trace
