module.exports = {
  /**
   * Application configuration section
   * http://pm2.keymetrics.io/docs/usage/application-declaration/
   */
  apps : [

    // First application
    {
      name      : "HarperDB",
      script    : "./server/index.js",
      env: {
        COMMON_VARIABLE: "true"
      },
      env_production : {
        NODE_ENV: "production"
      }
    },

    // Second application
    {
      name      : "WEB",
      script    : "web.js"
    }
  ],

  /**
   * Deployment section
   * http://pm2.keymetrics.io/docs/usage/deployment/
   */
  deploy : {
    production : {
      user : "harperdb",
      host : "127.0.0.1",
      ref  : "origin/master",
      repo : "git@github.com:repo.git:HarperDB/harperdb.git",
      path : "/harperdb",
      "post-deploy" : "npm install && pm2 startOrRestart ecosystem.config.js --only HarperDB"
    },
	dev : {
      user : "harperdb",
      host : [{host: 'local.harperdb.io', port: '22'}],
      ref  : "origin/master",
      repo : "git@github.com:HarperDB/harperdb.git",
      path : "/opt/harperdb_git",
      "post-deploy" : "npm install && pm2 startOrRestart /utility/devops/ecosystem.config.js --only HarperDB",
      env  : {
        NODE_ENV: "dev"
      }
    }
  }
}
