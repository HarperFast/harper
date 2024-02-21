variable "region" {}
variable "instance_count" {}
variable "instance_name_prefix" {}
variable "github_workflow_name" {}
variable "github_run_number" {}
variable "instance_type" {}
variable "volume_size" {}
variable "private_key" {
  default = "~/.ssh/github_rsa"
}

variable "security_group_id" {
  default = "sg-01b1c378328f897d1"
}

provider "aws" {
  version = "~> 3.0"
  region  = var.region
}

data "aws_ec2_instance_type" "ubuntu" {
  instance_type = var.instance_type
}

data "aws_ami" "ubuntu" {
  most_recent = true
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-*-server-*"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
  filter {
    name = "architecture"
    values = data.aws_ec2_instance_type.ubuntu.supported_architectures
  }
  owners = ["099720109477"] # Canonical
}

resource "aws_instance" "github" {
  count = var.instance_count
  tags = {
    Name                  = "${var.instance_name_prefix}-${count.index + 1}"
    github_workflow_name = var.github_workflow_name
    github_run_number   = var.github_run_number
  }
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = var.instance_type
  vpc_security_group_ids      = ["${var.security_group_id}"]
  subnet_id                   = "subnet-0e8a26e4dfe898d2c"
  associate_public_ip_address = true
  iam_instance_profile        = "AmazonSSMRoleForInstancesQuickSetup"
  key_name                    = "ci-instances"
  user_data                   = templatefile("${path.module}/user_data.sh", {})
  root_block_device {
    volume_type = "gp3"
    volume_size = var.volume_size
    iops        = 6000
    throughput  = 250
  }
  connection {
    type        = "ssh"
    user        = "ubuntu"
    private_key = file("${var.private_key}")
    host        = self.public_dns
  }
  # Copy all files and folders in ./upload dir to /home/ubuntu
  provisioner "file" {
    source      = "./upload/"
    destination = "/home/ubuntu"
  }
}

output "public_dns_names" {
  value = aws_instance.github.*.public_dns
}

output "public_ips" {
  value = aws_instance.github.*.public_ip
}

output "private_dns_names" {
  value = aws_instance.github.*.private_dns
}

output "private_ips" {
  value = aws_instance.github.*.private_ip
}

output "instance_ids" {
  value = aws_instance.github.*.id
}