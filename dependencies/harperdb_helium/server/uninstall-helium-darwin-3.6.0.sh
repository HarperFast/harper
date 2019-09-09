#!/bin/bash
if [ "$(id -u)" != "0" ]; then
   echo "This script must be run as root"
   exit 1
fi
rm /usr/local/lib/libhe.dylib
rm /usr/local/lib/libhe.a
rm /usr/local/include/he.h
rm /usr/local/bin/helium
rm /usr/local/share/doc/helium/helium.pdf
rm /usr/local/share/man/man1/helium.1.gz
rm /usr/local/share/man/man3/he.3.gz /usr/local/share/man/man3/he.h.3.gz /usr/local/share/man/man3/he_close.3.gz /usr/local/share/man/man3/he_commit.3.gz /usr/local/share/man/man3/he_delete.3.gz /usr/local/share/man/man3/he_delete_lookup.3.gz /usr/local/share/man/man3/he_discard.3.gz /usr/local/share/man/man3/he_enumerate.3.gz /usr/local/share/man/man3/he_exists.3.gz /usr/local/share/man/man3/he_insert.3.gz /usr/local/share/man/man3/he_is_read_only.3.gz /usr/local/share/man/man3/he_is_transaction.3.gz /usr/local/share/man/man3/he_is_valid.3.gz /usr/local/share/man/man3/he_iter_close.3.gz /usr/local/share/man/man3/he_iter_next.3.gz /usr/local/share/man/man3/he_iter_open.3.gz /usr/local/share/man/man3/he_iterate.3.gz /usr/local/share/man/man3/he_lookup.3.gz /usr/local/share/man/man3/he_merge.3.gz /usr/local/share/man/man3/he_next.3.gz /usr/local/share/man/man3/he_open.3.gz /usr/local/share/man/man3/he_perror.3.gz /usr/local/share/man/man3/he_prev.3.gz /usr/local/share/man/man3/he_remove.3.gz /usr/local/share/man/man3/he_rename.3.gz /usr/local/share/man/man3/he_replace.3.gz /usr/local/share/man/man3/he_stats.3.gz /usr/local/share/man/man3/he_strerror.3.gz /usr/local/share/man/man3/he_transaction.3.gz /usr/local/share/man/man3/he_update.3.gz /usr/local/share/man/man3/he_version.3.gz
rm /usr/local/share/man/man7/he_item.7.gz
echo "Helium uninstalled successfully."
exit 0
