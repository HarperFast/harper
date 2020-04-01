<img src="https://hdb-marketing.s3.amazonaws.com/Purple_Large1200TM.png" >

## Contents

1. [Getting Started](#getting-started)
2. [Running HarperDB](#running-harperdb)
3. [Stopping HarperDB](#stopping-harperdb)
4. [Restarting HarperDB](#restarting-harperdb)
5. [Check HarperDB Version](#check-harperdb-version)
6. [CRUD Samples](#crud-samples)
7. [HarperDB Studio](#harperdb-studio)
8. [Need Help?](#need-help)

**BETA Version please report your questions, comments and bugs to support@harperdb.io**
## Getting Started
**Prerequisites**
1. NodeJS 12.X
2. NPM
3. GCC Compiler
4. Make
5. Python 2.7
6. (Mac Developers) XCode is required.

The user will need elevated privileges or read and write access to install HarperDB with the -g flag.

```
npm install -g harperdb
```

or if you download the harperdb-2.0.0.tgz from products.harperdb.io

```
npm install -g harperdb-2.0.0.tgz
```

The first time you run HarperDB, it will prompt you to enter some configuration options. Once configured, HarperDB will start automatically.
* harperdb run

If you did not NPM install globaly your commands will need to be run in node_modules/harperdb/bin/ of the directory you ran NPM install in.
```
harperdb run

```
*    You will need read and write access to the HDB_ROOT (location of the root directory of the database) directory, default path is your users home directory i.e `/home/<user>/hdb`

*    You will be prompted for a database username and password during the install.

*    If HarperDB is already installed, the command 'harperdb' run will **NOT** run the installer.  Instead it will run 
     HarperDB.

*    Logs are located at HDB_ROOT/log/.  

## Running HarperDB

To run HarperDB after it is installed; run the following commands:

```
harperdb run

```
* You may need to update your firewall if you are not running locally, by default HarperDB runs on port 9925.  If you are unsure see your properties file at HDB_ROOT/config/settings.js.

## Stopping HarperDB

To stop HarperDB once it is running from the HarperDB home (HDB_HOME) directory run the following commands:

```
harperdb stop

```

## Restarting HarperDB

To restart HarperDB once it is running from the HarperDB home (HDB_HOME) directory run the following commands:

```
harperdb restart

```

## Check HarperDB version

To check the version you are running of HarperDB from the HarperDB home (HDB_HOME) directory run the following commands:

```
harperdb version

```
## CRUD samples
We really like postman.  We like it so much, we have created a series of examples that can be run to create 
and access sample data in HarperDB.  

Get Postman here! https://www.getpostman.com/
Our Postman 'Getting Started' samples can be found on our examples page: http://examples.harperdb.io/.  Click the "Run in Postman" button then run the samples 
from top to bottom to learn how to create, populate, and query our sample 'dog' database.  Woof.

Sample code is also available in many common languages in the sample code pane.  Select the language you want from the drop down and 
paste the code. See the Postman documentation on supported languages here: https://www.getpostman.com/docs/postman/sending_api_requests/generate_code_snippets

## HarperDB Studio
Need a UI? HarperDB Studio is a web based UI for managing users, roles, and schemas. The HarperDB Studio also enables you to run NoSQL & SQL queries, create charts, save your favorite queries & charts and share them via live links to your organization.

https://studio.harperdb.io/

## Need Help

-contact us via email: support@harperdb.io

-[Support Portal](https://harperdbhelp.zendesk.com)
-[Documentation](https://docs.harperdb.io/)
-[Getting Started Examples](http://examples.harperdb.io/)

**Thank You to Rajat Kumar rajat.io for allowing us to take over this package name.  Find his harperdb client at https://www.npmjs.com/package/harperdb-client**
