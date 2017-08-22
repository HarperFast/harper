![alt text](https://s3.amazonaws.com/hdb-marketing/purple_logo_transparent_662x400.png)

## Contents

1. [Getting Started](#getting-started)
2. [Register HarperDB](#register-harperdb)
3. [Running HarperDB](#running-harperdb)
4. [Stopping HarperDB](#stopping-harperdb)
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

*    If HarperDB is already installed hdb_run will **NOT** run the installer.

*    Logs for installation are found in the HarperDB home directory (HDB_HOME). Other logs are located at HDB_ROOT/log/.

## Register HarperDB

During the installation process you will be asked to register, this is optional.

If you do choose to register at a later time execute the following commands from the HarperDB home (HDB_HOME) directory:

```
cd HDB_HOME/bin
./harperdb register

```

Enter your company name when prompted **IMPORTANT: you must remember your entry exactly**

You will then be supplied a fingerprint like so **JmLiR4xj60042e9ee22a91956ab630b490b48c083.**
Then navigate to [HarperDB] (http://harperdb.io/register. in your web browser.)

You will be asked to enter your company name and fingerprint.

You will be returned a license key like so **c6a8d0685220d216b8fd77d87cdf3b5bmofi25U7GkrYHmQ1d718f878c31a2e88178c2c76646e8ee**

Copy and paste license key to the command line where requested.

You should then be successfully registered.

    *Each fingerprint is unique to a device.  Each license is unique to a fingerprint.*

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


## Need Help?

-contact us via email: support@harperdb.io

-[Support Portal](https://harperdbhelp.zendesk.com)


