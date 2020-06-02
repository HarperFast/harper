#!/bin/bash

function=$1
args_num=$#
install_script_values=""
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
      echo -e "\e[31;1;4m!!NOTICE!! to persist data requires a mounted host volume\e[0m"
      echo -e "\e[1mOptional Arguments for CLI and Environment Variables: \e[0m"
      echo "    --INIT_HDB_USERNAME (default HDB_ADMIN)"
      echo "    --INIT_HDB_PASSWORD (default password)"
      echo "    --INIT_ENABLE_CLUSTERING (Enabling Flag, no value required; default false)"
      echo "    --INIT_CLUSTER_USERNAME (default cluster_user; only if Clustering is Enabled )"
      echo "    --INIT_CLUSTER_PASSWORD(default password; only if Clustering is Enabled)"
      echo "    --INIT_CLUSTER_PORT  (default 1111; only if Clustering is Enabled)"
      echo "    --INIT_NODE_NAME  (default docker_node; only if Clustering is Enabled)"
      echo "************ **********  ***************"
      echo "Example docker run command with all command line optional arguments:"
      echo -e "\e[35mdocker run -v /tmp/hdb/:/opt/harperdb/hdb/ harperdb/hdb --INIT_HDB_USERNAME HDB_ADMIN --INIT_HDB_PASSWORD password --INIT_ENABLE_CLUSTERING --INIT_CLUSTER_USERNAME cluster_user --INIT_CLUSTER_PASSWORD password --INIT_CLUSTER_PORT 1234 --INIT_NODE_NAME docker_node\e[0m"
      echo "Environment Variable Example"
      echo -e "\e[35mdocker run -v /tmp/hdb/:/opt/harperdb/hdb/ -e INIT_HDB_USERNAME=HDB_ADMIN -e INIT_HDB_PASSWORD=password -e INIT_ENABLE_CLUSTERING=true -e INIT_CLUSTER_UNERNAME=cluster_user -e INIT_CLUSTER_PASSWORD=password -e INIT_CLUSTER_PORT=1234 -e INIT_NODE_NAME=docker_node harperdb/hdb \e[0m"
      exit 0
}


function arguments_parsing()
{
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
     "--INIT_CLUSTER_PORT")
     shift
     clustering_port=$1
     install_arguments[8]="--CLUSTERING_PORT $clustering_port"
     arg_vals["$args_helper"]="clustering_port"
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
     "--INIT_ENABLE_CLUSTERING")
     clustering_enabled=$1
     install_arguments[10]="--enable_clustering"
     arg_vals["$args_helper"]="enable_clustering"
     ((args_helper++))
     shift
     ;;
     *) echo "Something went wrong please double check the arguments list: $@"
      arguments_help 
      shift
     ;;
    esac
done

the_command_arguments=("${install_arguments[@]}")

}

function clean_install()
{
  schema=$(ls /opt/harperdb/hdb/ | grep schema)
  if [ ! -z $schema ];
  then
	  harperdb_run
  else
   rm -rf /home/node/.harperdb
   rm -rf /home/node/hdb_tmp/*
   echo "********* Cleaned Original install **************"
   cd /home/node/
  echo "harperdb install ${the_command_arguments[@]}";
  harperdb version
  install_script_values="install ${the_command_arguments[@]}";
  harperdb $install_script_values;

fi
}

function harperdb_run()
{
   echo "Running HarperDB"
   harperdb foreground
   
}

function environment_variable_check()
{
  environment_variables=0 
  the_command_arguments=("--TC_AGREEMENT yes" "--HDB_ROOT /opt/harperdb/hdb" "--HTTP_PORT 9925" "--HTTPS_PORT 31283" "--HDB_ADMIN_USERNAME HDB_ADMIN" "--HDB_ADMIN_PASSWORD password" "--CLUSTERING_USERNAME cluster_user" "--CLUSTERING_PASSWORD password" "--CLUSTERING_PORT 1111" "--NODE_NAME docker_node") 
  if [ ! -z "$INIT_HDB_USERNAME" ]; 
  then
     the_command_arguments[4]="--HDB_ADMIN_USERNAME $INIT_HDB_USERNAME"
     environment_variables=$((environment_variables + 1))
  fi
  if [ ! -z "$INIT_HDB_PASSWORD" ];
  then
     the_command_arguments[5]="--HDB_ADMIN_PASSWORD $INIT_HDB_PASSWORD"
     environment_variables=$((environment_variables + 1))
  fi
  if [ ! -z "$INIT_CLUSTER_USERNAME" ];
  then
     the_command_arguments[6]="--CLUSTERING_USERNAME $INIT_CLUSTER_USERNAME"
     environment_variables=$((environment_variables + 1))
  fi
  if [ ! -z "$INIT_CLUSTER_PASSWORD" ];
  then
     the_command_argument[7]="--CLUSTERING_PASSWORD $INIT_CLUSTER_PASSWORD"
     environment_variables=$((environment_variables + 1))
  fi
  if [ ! -z "$INIT_CLUSTER_PORT" ];
  then
     the_command_arguments[8]="--CLUSTERING_PORT $INIT_CLUSTER_PORT"
     environment_variables=$((environment_variables + 1))
  fi
  if [ ! -z "$INIT_NODE_NAME" ];
  then
     the_command_arguments[9]="--NODE_NAME $INIT_NODE_NAME"
     environment_variables=$((environment_variables + 1))
  fi
  if [ ! -z "$INIT_ENABLE_CLUSTERING" ];
  then
     the_command_arguments[10]="--enable_clustering"
     environment_variables=$((environment_variables + 1))
  fi
  args_helper=$environment_variables 
  
}
#END Function Definitions


#******************************************************#
#                  Main Function                       #
environment_variable_check
if [[ "$args_helper" -gt 0 ]]; then
	clean_install
        harperdb_run
else
	
  if [ $# -eq 0 ];
  then
    echo "Starting HarperDB"
    sh /usr/local/bin/hdb_docker_init.sh
    harperdb_run
  else

     case "$function" in
        "run") echo "Starting HarperDB"
        sh /usr/local/bin/hdb_docker_init.sh
        harperdb_run
        ;;
     "help") echo "Help Information"
        arguments_help
        ;;
     \-\-*) echo "Parsing arguments and installing HarperDB with provided parameters."
        arguments_parsing ${@:1}
        clean_install
        harperdb_run
        ;;
     *) echo "starting container."
        sh /usr/local/bin/hdb_docker_init.sh
        harperdb_run
        ;;
     esac
   fi
fi
