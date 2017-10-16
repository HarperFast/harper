![alt text](https://s3.amazonaws.com/hdb-marketing/purple_logo_transparent_662x400.png)

## Contents

1. [Getting Started](#getting-started)
2. [Running HarperDB](#running-harperdb)
3. [Stopping HarperDB](#stopping-harperdb)
4. [CRUD Samples](#crud-samples)
5. [Need Help?](#need-help)


## Getting Started
After downloading the compressed file, unpack to your desired location.
This location is referred to as HDB_HOME further in the documentation.

**All HarperDB commands must be run in the bin directory from within HDB_HOME.**

**The operating system user who installed HarperDB is the only user that can start and run the HarperDB service.**

HarperDB can be installed in one of two ways
* ./harperdb install
* ./harperdb run

The process is the same; however, ./harperdb run will also start HarperDB.

From the HarperDB root directory execute the following:

```
cd HDB_HOME/bin
./harperdb install

```

or run


```
cd HDB_HOME/bin
./harperdb run

```
*    You will need read and write access to the HDB_ROOT (location of the root directory of the database) directory, default path is your current working directory.

*    You will be prompted for a database username and password during the install.

*    If HarperDB is already installed, the command './harperdb' run will **NOT** run the installer.  Instead it will run 
     HarperDB.

*    Logs for installation are found in the HarperDB home directory (HDB_HOME). Other logs are located at HDB_ROOT/log/.

## Running HarperDB

To run HarperDB after it is installed from the HarperDB home (HDB_HOME) directory; run the following commands:

```
cd HDB_HOME/bin
./harperdb run

```
* You may need to update your firewall if you are not running locally, by default HarperDB runs on port 9925.  If you are unsure see your properties file at HDB_ROOT/config/settings.js.

## Stopping HarperDB

To stop HarperDB once it is running from the HarperDB home (HDB_HOME) directory run the following commands:

```
cd HDB_HOME/bin
./harperdb stop

```

## Restarting HarperDB

To restart HarperDB once it is running from the HarperDB home (HDB_HOME) directory run the following commands:

```
cd HDB_HOME/bin
./harperdb restart

```


## Check HarperDB version

To check the version you are running of HarperDB from the HarperDB home (HDB_HOME) directory run the following commands:

```
cd HDB_HOME/bin
./harperdb version

```
## CRUD samples
We really like postman.  We like it so much, we have created a series of examples that can be run to create 
and access sample data in HarperDB.  

Get Postman here! https://www.getpostman.com/
Our Postman 'Getting Started' samples can be found on our collections page: https://blue-rocket-8751.postman.co/collections/1893441-1927d979-5a96-0dab-26db-6648778a1c94.  Click the "Run in Postman" button then run the samples 
from top to bottom to learn how to create, populate, and query our sample 'dog' database.

Sample code is also available in many common languages in the sample code pane.  Select the language you want from the drop down and 
paste the code. See the Postman documentation on supported languages here: https://www.getpostman.com/docs/postman/sending_api_requests/generate_code_snippets

## Need Help

-contact us via email: support@harperdb.io

-[Support Portal](https://harperdbhelp.zendesk.com)
-[Documentation](https://docs.harperdb.io/)
-[Getting Started Examples](https://blue-rocket-8751.postman.co/collections/1893441-1927d979-5a96-0dab-26db-6648778a1c94)


