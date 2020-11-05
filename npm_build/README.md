<img src="https://hdb-marketing.s3.amazonaws.com/Purple_Large1200TM.png" >

## Contents

1. [Installing HarperDB](#installing-harperdb)
2. [Starting HarperDB](#starting-harperdb)
3. [Stopping HarperDB](#stopping-harperdb)
4. [Restarting HarperDB](#restarting-harperdb)
5. [Getting the HarperDB Version](#getting-the-harperdb-version)
6. [Using the Built-In API](#using-the-built-in-api)
7. [HarperDB Studio](#harperdb-studio)
8. [Need Help?](#need-help)

## Installing HarperDB
**Prerequisites**
1. Node.js 12 and npm
2. GCC
3. Make
4. Python v2.7, v3.5, v3.6, v3.7, or v3.8
5. (macOS) Xcode

```
npm install -g harperdb
harperdb install
```
HarperDB will prompt you for configuration options during install.

## Starting HarperDB

```
harperdb run

```

## Stopping HarperDB

```
harperdb stop

```

## Restarting HarperDB

```
harperdb restart

```

## Getting the HarperDB Version

```
harperdb version

```
## Using the Built-In API
Using HarperDB’s built-in API is as easy as making an http call to the URL and PORT of your HarperDB instance. To make it even easier, we’ve created a series of example http calls as a Postman Collection. These calls show you how to create and access sample data in HarperDB.

[Postman Collection](https://docs.harperdb.io/)

Sample code is also available in many common languages in the sample code pane. Select the language you want from the drop down and paste the code.

## HarperDB Studio
Every Installation of HarperDB can be administered through HarperDB Studio. This web-based interface provides you the ability to set up new schemas and tables, configure users and roles, manage data replication, and purchase and deploy enterprise licenses.

[HarperDB Studio](https://studio.harperdb.io/)

* Simplify Administration – handle all HarperDB administration tasks from one simple interface
* Once you’re logged in, select Add Instance > User-Installed Instance, and enter your instance details
* The Studio makes use of your HarperDB instance’s built-in API
* Credentials for all your instances are stored locally in your browser- we never see or store them
* You’ll be able to manage any instance you can reach via your network connection
* Even though the Studio is cloud-hosted, you can securely manage User-Installed instances on your private network

## Need Help

support@harperdb.io

[Support Portal](https://harperdbhelp.zendesk.com)

[Documentation](https://docs.harperdb.io/)

**Thank You to Rajat Kumar rajat.io for allowing us to take over this package name.  Find his harperdb client at https://www.npmjs.com/package/harperdb-client**

