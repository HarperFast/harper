variable "region" {}
variable "instance_count" {}
variable "instance_name_prefix" {}
variable "teamcity_buildconf_name" {}
variable "teamcity_build_number" {}
variable "instance_type" {}
variable "volume_size" {}
variable "private_key" {
    default = "~/.ssh/teamcity_rsa"
}

provider "aws" {
  version = "~> 3.0"
  region = var.region
}

data "aws_ami" "ubuntu" {
  most_recent = true
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-bionic-18.04-amd64-server-*"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
  owners = ["099720109477"] # Canonical
}

resource "aws_instance" "teamcity" {
  count                       = var.instance_count
  tags = {
    Name                      = "${var.instance_name_prefix}-${count.index + 1}"
    teamcity_buildconf_name   = var.teamcity_buildconf_name
    teamcity_build_number     = var.teamcity_build_number
  }
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = var.instance_type
  vpc_security_group_ids      = ["sg-00e163456e4035171"]
  subnet_id                   = "subnet-5ba0ee32" # Needed?
  associate_public_ip_address = true
  iam_instance_profile        = "AmazonSSMRoleForInstancesQuickSetup"
  key_name                    = "teamcity-agent"
  user_data                   = templatefile("${path.module}/user_data.sh", {})
  placement_group			  = "teamcity"
  root_block_device {
      volume_type             = "gp3"
      volume_size             = var.volume_size
      iops					  = 6000
      throughput			  = 250
  }
  connection {
    type        = "ssh"
    user        = "ubuntu"
    private_key = "${file("${var.private_key}")}"
    host        = "${self.public_dns}"
  }
  # Copy all files and folders in ./upload dir to /home/ubuntu
  provisioner "file" {
    source      = "./upload/"
    destination = "/home/ubuntu"
  }
}

output "public_dns_names" {
  value = aws_instance.teamcity.*.public_dns
}

output "public_ips" {
  value = aws_instance.teamcity.*.public_ip
}

output "instance_ids" {
  value = aws_instance.teamcity.*.id
}