# Running it on Google Cloud

One `e2-micro` is plenty. In `us-west1`, `us-central1` or `us-east1` the VM itself is in the Always Free tier (one e2-micro, 30 GB standard disk, 1 GB egress a month). Discord has no IPv6, so the VM needs an external IPv4 address, which Google bills at about $0.005 an hour (roughly $3.65 a month) on top of that. Nothing listens on the VM, so no firewall rules or load balancer.

## Create the VM

With the `gcloud` CLI logged in and a project selected:

```sh
gcloud compute instances create tribunal \
  --zone=us-central1-a \
  --machine-type=e2-micro \
  --image-family=debian-12 --image-project=debian-cloud \
  --boot-disk-size=20GB --boot-disk-type=pd-standard \
  --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
  --no-service-account --no-scopes
```

If you want nightly backups copied off the VM, create a bucket and give the VM a service account with `roles/storage.objectCreator` on it, instead of `--no-service-account`:

```sh
gcloud storage buckets create gs://YOUR-BUCKET --location=us-central1 --uniform-bucket-level-access
gcloud iam service-accounts create tribunal-vm
gcloud storage buckets add-iam-policy-binding gs://YOUR-BUCKET \
  --member=serviceAccount:tribunal-vm@YOUR-PROJECT.iam.gserviceaccount.com --role=roles/storage.objectCreator
# then pass --service-account=tribunal-vm@YOUR-PROJECT.iam.gserviceaccount.com --scopes=storage-rw to instances create
```

## Install

```sh
gcloud compute ssh tribunal --zone=us-central1-a
sudo apt-get update && sudo apt-get install -y git rsync
git clone https://github.com/forrestblade/tribunal.git
sudo tribunal/deploy/install.sh
```

The first run creates `/etc/tribunal/env` and `/opt/tribunal/config.json` and prints the remaining steps: paste the token, fill in the ids, register the commands, enable the service.

## Update

```sh
cd ~/tribunal && git pull && sudo deploy/install.sh
```

## Look at it

```sh
sudo journalctl -u tribunal -f            # live log
sudo systemctl status tribunal            # is it up
ls /opt/tribunal/data/backups             # nightly snapshots
sudo -u tribunal sqlite3 /opt/tribunal/data/tribunal.db 'select id, kind, step_id, status from cases order by id desc limit 10'
```

`apt-get install sqlite3` if you want the last one.

## Restore

Stop the service, copy a snapshot over `/opt/tribunal/data/tribunal.db`, start it again. Timers and scheduled unbans live in the database, so nothing else needs to be done.
