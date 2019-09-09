Helium
======

Helium Core Library

Copyright (C) 2013-2019, Levyx, Inc.

Linux
-----

### Install Files

| File                          | Summary                |
|-------------------------------|------------------------|
| `README.md`                   | This file              |
| `helium.pdf`                  | Helium manual          |
| `install-helium-xxx-xxx.sh`   | The installer script   |
| `uninstall-helium-xxx-xxx.sh` | The uninstaller script |
| `helium`                      | The helium executable  |

Install
-------

Run `install-helium-xxx-xxx.sh` as root.
```
# ./install-helium-xxx-xxx.sh
```

Verify that the Helium application installed correctly.
```
$ helium --version
```

Verify that the Helium library files were installed correctly.
```
$ gcc -Wall -lhe -pthread check_helium.c -o check_helium
$ ./check_helium
```

Using this file for `check_helium.c`:
```c
#include <stdio.h>
#include <he.h>

int main()
{
    int major, minor, patch;
    he_version(&major, &minor, &patch);
    if ((HE_VERSION_MAJOR != major) ||
        (HE_VERSION_MINOR != minor) ||
        (HE_VERSION_PATCH != patch)) {
        printf("Helium library version mismatch!\n");
        return 1;
    } else {
        printf("Helium library version is ok!\n");
        return 0;
    }
}
```

Uninstall
---------

Run `uninstall-helium-xxx-xxx.sh` as root.
```
# ./uninstall-helium-xxx-xxx.sh
```

Notes
-----

When installing a new version of Helium, the old version of Helium is
uninstalled automatically.

The installer copies the following files to your system:

| File                         | Installation location        |
|------------------------------|------------------------------|
| `libhe.so` (dynamic library) | `/usr/lib`                   |
| `libhe.a` (static library)   | `/usr/lib`                   |
| `he.h` (header files)        | `/usr/include`               |
|  all man pages               | `/usr/share/man`             |
| `helium` (application)       | `/usr/bin`                   |

Windows
-------

Install Files
-------------

| File                           | Summary                |
|--------------------------------|------------------------|
| `README.md`                    | This file              |
| `helium.pdf`                   | Helium manual          |
| `install-helium-xxx-xxx.bat`   | The installer script   |
| `uninstall-helium-xxx-xxx.bat` | The uninstaller script |
| `helium`                       | The helium executable  |

Install
-------

Run the installer as admin
```
C:\> install-helium-xxx-xxx.bat
```

Verify that the Helium application was installed correctly
```
C:\> C:\helium\helium --version
```

Verify that the Helium library files were installed correctly
```
C:\> cl check_helium.c /IC:\helium\include C:\helium\lib\he.lib
```

Using this file for `check_helium.c`:
```c
#include <stdio.h>
#include <he.h>

int main()
{
    int major, minor, patch;
    he_version(&major, &minor, &patch);
    if ((HE_VERSION_MAJOR != major) ||
        (HE_VERSION_MINOR != minor) ||
        (HE_VERSION_PATCH != patch)) {
        printf("Helium library version mismatch!\n");
        return 1;
    } else {
        printf("Helium library version is ok!\n");
        return 0;
    }
}
```

Uninstall
---------

Run the uninstaller as admin:
```
C:\> uninstall-helium-xxx-xxx.bat
```

This will prompt you to delete the entire `C:\helium` dir in order
to uninstall Helium.

Frequently Asked Questions
--------------------------

**Q**) What is the minimum size of a device or file for use with Helium?

We recommend 1 GiB minimum.


**Q**) I don't like to use an entire device for Helium. What do I do?

Partition the device, and dedicated a partition for use with Helium.
Helium will be happy to use just the partition and leave the partition table
and other partitions on the device alone. Or, create a file on the device of a
desired size. Then, create Helium datastores on that file. Note that you will pay
an approximate 5% performance penalty for using files instead of devices.


**Q**) Is my data on a raw device (e.g., a file system) going to remain safe if I
use this device with Helium?

ABSOLUTELY NOT. Helium will over-write the raw device it has been given for
use. Anything that was on that raw device will be over-written.


**Q**) How do I run a memory only test?

A device URL starting with an underscore implies a memory device. For
example: `he://./_1000000000` will run helium on a virtual device that
is in memory and a size of 10^9 bytes.

**Q**) I do not have root access. How do I install the Helium library?

Contact Levyx, Inc. to obtain the static library (`libhe.a`) and header file
(`he.h`). Place these files in your application directory. Change your build
process to link against the static Helium library.


**Q**) How do I make sure Helium was installed and is operating correctly?

```
$ truncate -s 1g path_to_file
$ helium --test --nowarn he://./path_to_file
```

(you should see a number of tests running with a PASS/FAIL message)


**Q**) How do I create a loop device?

```
$ truncate -s 1g path_to_file
# losetup /dev/loop0 path_to_file

$ helium --test --nowarn he://.//dev/loop0
```

(you should see a number of tests running with a PASS/FAIL message)
```
# losetup -d /dev/loop0
```
(will remove this device if needed)


**Q**) Helium errors out with "Incorrect QueryPerformanceFrequency"

Contact Levyx, Inc. The reason is as follows:
It is possible that the machine you are running Windows on, does not
have a time stamp counter (TSC) that is reliable. Please read the
following notes from Microsoft MSDN to determine if you have a
compatible BIOS that can be relied upon for sub millisecond counters.

http://msdn.microsoft.com/en-us/library/windows/desktop/dn553408(v=vs.85).aspx

**Q**) How can I compile on Windows from command line?
```
C:\> cd test.c /IC:\helium\include C:\helium\lib\he.lib
```

**Q**) How can I run Helium on Windows?

Running on a large file as a Helium data store:
```
C:\> helium --perf he://./C:\\Users\\foo\\Desktop\\1gbfile
```

Running on a volume as a Helium data store:
```
C:\> helium --perf he://./\\.\Volume{10812666-b090-11e4-828e-000c29287b59}
```

Note that the device volume information can be found out on Windows using:
 (i) `mountvol`
 (ii) `dd --list` (If dd for Windows is installed)
 
Also note that the device volume must be unmounted and initialized.

**Q**) How do I create a sparse file in Windows ?

Using fsutil:
```
fsutil file createnew 1gbfile 0x40000000
fsutil sparse setflag 1gbfile
```

Using dd for Windows:
```
dd if=/dev/zero of=1gbfile bs=1k count=1 seek=1M
```

Using fsutil:
```
fsutil file createnew 1gbfile 0x40000000
fsutil sparse setflag 1gbfile
```

Using dd for Windows:
```
dd if=/dev/zero of=1gbfile bs=1k count=1 seek=1M
```

**Q**) I receive an HE_ERR_MEMORY error when using the Java version of Helium. What can I do to resolve this issue?

This error is propagated from an OutOfMemory error in Maven derived from its default settings. To resolve, either add this to the machine's bashrc or export the following maven option from the terminal/command line manually:

On Linux systems:
```
export MAVEN_OPTS='-Xmx512m -XX:MaxPermSize=128m'
```

On Windows systems:
```
set MAVEN_OPTS=-Xmx512m -XX:MaxPermSize=128m
```



Portability
-----------

* OS X 10.10, GCC 4.2.1
* Linux 3.10.0, GCC 4.8.2 (CentOS 7.0)
* Windows server 2008 R2 SP1, Microsoft C++ compiler cl 18.00.31101
* Android 7.0 arm64, Android NDK r16
