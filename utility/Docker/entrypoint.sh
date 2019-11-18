#!/bin/bash

function=$1
password=$2
args_num=$#
##Array with all default values for HarperDB installation, will update array indexes for cli provided arguments in function arguments_parsing
install_arguments=("--TC_AGREEMENT yes" "--HDB_ROOT /opt/harperdb/hdb" "--HTTP_PORT 9925" "--HTTPS_PORT 31283" "--HDB_ADMIN_USERNAME HDB_ADMIN" "--HDB_ADMIN_PASSWORD password" "--CLUSTERING_USERNAME cluster_user" "--CLUSTERING_PASSWORD password" "--CLUSTERING_PORT 1111" "--NODE_NAME docker_node")
arg_vals=()
args_helper=0
####### Function Definitions begin************

function arguments_help()
{
      echo "HarperDB Docker entrypoint help"
      echo -e "Allowed functions; \e[31mhelp, \e[31mrun, \e[31m[ Optional Arguments ]\e[0m"
      echo -e "help returns this menu"
      echo -e "run or no arguments starts HarperDB"
      echo -e "\e[31;1;4mNOTE to persist data requires a mounted host volume\e[0m"
      echo -e "\e[1mOptional Aarguments: \e[0m"
      echo "    --INIT_HDB_USERNAME (default HDB_ADMIN)"
      echo "    --INIT_HDB_PASSWORD (default password)"
      echo "    --INIT_CLUSTER_USERNAME (default cluster_user)"
      echo "    --INIT_CLUSTER_PASSWORD(default password)"
      echo "    --INIT_NODE_NAME  (default docker_node)"
      echo "************ **********  ***************"
      exit 0
}


function arguments_parsing()
{
##Assign values to provided arguments.
##shift past first argument install
#while $#(number of passed arguments) is greater than zero, the shift command decrements this process..
while [[ $# -gt 0 ]]; 
do
   case "$1" in
    "--INIT_HDB_USERNAME")
    shift
    hdb_admin_username=$1
    install_arguments[4]="--HDB_ADMIN_USERNAME $hdb_admin_username"
     arg_vals["$args_helper"]="hdb_admin_username"
     ((args_helper++))
    shift
    ;;
     "--INIT_HDB_PASSWORD")
    shift
    hdb_admin_password=$1
    install_arguments[5]="--HDB_ADMIN_PASSWORD $hdb_admin_password"
    arg_vals["$args_helper"]="hdb_password"
    ((args_helper++))
    shift
    ;;
    "--INIT_CLUSTER_USERNAME")
     shift
     clustering_username=$1
     install_arguments[6]="--CLUSTERING_USERNAME $clustering_username"
     arg_vals["$args_helper"]="clustering_username"
     ((args_helper++))
     shift
     ;;
   "--INIT_CLUSTER_PASSWORD")
     shift
     clustering_password=$1
     install_arguments[7]="--CLUSTERING_PASSWORD $clustering_password"
     arg_vals["$args_helper"]="clustering_password"
     ((args_helper++))
     shift
     ;;
   "--INIT_NODE_NAME")
     shift
     node_name=$1
     install_arguments[9]="--NODE_NAME $node_name"
     arg_vals["$args_helper"]="node_name"
     ((args_helper++))
     shift
     ;;
     *) echo "Something went wrong please double check the arguments list: $@"
      arguments_help 
      shift
     ;;
    esac
done

the_command_arguments="install "

for i in ${install_arguments[*]}
do
  the_command_arguments+="$i "
done

echo "**INFO**: Arguments passed to HarperDB initializer: $the_command_arguments"
}

function clean_install()
{
  schema=$(ls /opt/harperdb/hdb/)
  if [ ! -z $schema ];
  then
	  harperdb_run
  else
  ## remove default installation artifacts
   rm -rf /home/node/.harperdb/
   rm -rf /home/node/hdb_tmp/*
   echo "********* Cleaned Original install **************"
## run install with new parameters provided by command line
   cd /home/node/
   harperdb $the_command_arguments
   fi
}

function harperdb_run()
{
## run harperdb in foreground to prevent container from closing.
    harperdb foreground
}

#END Function Definitions


#******************************************************#
#                  Main Function                       #

#passing arguments 1 to last to be parsed by arguments_parsing
#arguments_parsing ${@:1}
if [ $# -eq 0 ];
then
   echo "Starting HarperDB"
   harperdb_run
else
#Check what function i.e install, register, addnode, think of other functions a docker user will need.
case "$function" in
"run") echo "Starting HarperDB"
    harperdb_run
    ;;
"help") echo "Help Information"
    arguments_help
    ;;
\-\-*)  echo "Parsing arguments and installing HarperDB with provided parameters."
    arguments_parsing ${@:1}
    clean_install
    harperdb_run
    ;;
*) echo "HarperDB did not find qualified arguments.  Deploying container."
   exec "$@"
   ;;
esac
fi
