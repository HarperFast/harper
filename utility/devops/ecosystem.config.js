module.exports = {
  /**
   * Application configuration section
   * http://pm2.keymetrics.io/docs/usage/application-declaration/
   */
  apps : [

    // First application
    {
      name      : "HarperDB",
      script    : "../server/hdb_express.js",
      env: {
        COMMON_VARIABLE: "true"
      },
      env_production : {
        NODE_ENV: "production"
      }
    },
	  {
		        name      : "HarperDB_schema_trigger",
		        script    : "../triggers/hdb_schema_triggers.js",
		        env: {
				        COMMON_VARIABLE: "true"
				      },
				      env_production : {
				        NODE_ENV: "production"
				      }
		      },
      {
          name      : "HarperDB_attribute_trigger",
          script    : "../triggers/attribute_triggers.js",
          env: {
              COMMON_VARIABLE: "true"
          },
          env_production : {
              NODE_ENV: "production"
          }
      }
 ],

  /**
   * Deployment section
   * http://pm2.keymetrics.io/docs/usage/deployment/
   */
  deploy : {
    aws : {
      user : "ubuntu",
      host : "dev.harperdb.io",
      ref  : "origin/master",
      repo : "git@github.com:HarperDB/harperdb.git",
      path : "/opt/harperdb_git",
      "pre-setup" : "rm -rf ./node_modules",
      "post-deploy" : "npm install && pm2 startOrRestart utility/devops/ecosystem.config.js"
    },
	dev : {
      user : "harperdb",
      host : [{host: 'local.harperdb.io', port: '22'}],
      ref  : "origin/master",
      repo : "git@github.com:HarperDB/harperdb.git",
      path : "/opt/harperdb_git",
      "pre-setup" : "rm -rf ./node_modules",
      "post-deploy" : "npm install && pm2 startOrRestart utility/devops/ecosystem.config.js",
      env  : {
        NODE_ENV: "dev"
      }
    }
  }
}
