![alt text](https://s3.amazonaws.com/hdb-marketing/purple_logo_transparent_1000x604.png)

## Contents

1. [Getting Started](#getting-started)
2. [Register HarperDB](#register-harperdb)
3. [Running HarperDB](#running-harperdb)
4. [Stopping HarperDB](#stopping-harperdb)
5. [Need Help?](#need-help)



## Getting Started
HarperDB can be installed in one of two ways
* bin/run
* bin/install

The process is the same; however, bin/run will also start HarperDB.

From the HarperDB root directory execute either of the following:

```

cd bin
node run

```

or run


```

cd bin
node install

```

*    HarperDB requires root/admin access to install inotifywait.

*    You will be prompted to for a password during the install.

*    If HarperDB is already installed bin/run will **NOT** run the installer.


## Register HarperDB

During the installation process you will be asked to if you wish to register at that time.

If you do not register at that time execute the following commands from the HarperDB root directory:

```
cd bin
node register

```

Enter your company name when prompted **IMPORTANT: you must remember your entry exactly**

You will then be supplied a fingerprint like so **JmLiR4xj60042e9ee22a91956ab630b490b48c083.**
Then navigate to [HarperDB] (http://harperdb.io/register. in your web browser.)


You will be asked to enter your company name and fingerprint.

You will be returned a license key like so **c6a8d0685220d216b8fd77d87cdf3b5bmofi25U7GkrYHmQ1d718f878c31a2e88178c2c76646e8ee**

copy and paste this to the command line where requested.

You should then be successfully registered.

    *Each fingerprint is unique to a device.  Each license is unique to a fingerprint.*








## Running HarperDB

To run HarperDB after it is installed from the HarperDB directoy run the following commands:

```

cd bin
node run

```

## Stopping HarperDB

To stop HarperDB once it is running from the HarperDB directory run the following commmands:
```

cd bin
node stop

```

## Need Help?

-contact us via email: support@harperdb.io








