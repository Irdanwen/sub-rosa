#!/bin/sh
cd project
sha=$(git log -g --format='%h %s' | awk '/write the deployment checklist/ {print $1; exit}')
git reset -q --hard "$sha"
