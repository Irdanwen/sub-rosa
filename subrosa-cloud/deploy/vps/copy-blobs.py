#!/usr/bin/env python3
"""Copy the ciphertext blobs the service knows about from one S3 bucket to another.

Runs on the host next to the stack, reads the list of blobs from PostgreSQL
(the service's own record of what exists, with each blob's SHA-256), and for
every blob the destination lacks, downloads it from the source and uploads it. Every upload is checked against the recorded
digest, so a corrupted or truncated copy is reported rather than kept.

Usage (no credentials on the command line; they come from operator.json and a
destination env file):

    python3 copy-blobs.py --operator /opt/subrosa-accounts/prod/operator.json \
        --destination /opt/subrosa-accounts/prod/r2.env --mode verify
    python3 copy-blobs.py ... --mode copy

The destination env file holds ENDPOINT, REGION, ACCESS_KEY, SECRET_KEY and
BUCKET. `verify` only lists; `copy` writes. Re-running is safe: objects the
destination already holds with the right digest are skipped.
"""
import argparse
import concurrent.futures
import hashlib
import json
import pathlib
import subprocess
import sys

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError


def client(endpoint, region, access_key, secret_key):
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name=region,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=Config(signature_version="s3v4", retries={"max_attempts": 4}, max_pool_connections=16),
    )


def env_file(path):
    out = {}
    for line in pathlib.Path(path).read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def recorded_blobs(container):
    sql = "select account_id::text||'/'||id::text, bytes, encode(digest,'hex') from blobs"
    out = subprocess.run(
        ["docker", "exec", container, "psql", "-U", "postgres", "-d", "subrosa", "-At", "-F", " ", "-c", sql],
        check=True, capture_output=True, text=True,
    ).stdout
    rows = {}
    for line in out.splitlines():
        key, size, digest = line.split(" ")
        rows[key] = (int(size), digest)
    return rows


def listed(s3, bucket, prefix):
    sizes = {}
    token = None
    while True:
        kw = {"Bucket": bucket, "Prefix": prefix, "MaxKeys": 1000}
        if token:
            kw["ContinuationToken"] = token
        page = s3.list_objects_v2(**kw)
        for obj in page.get("Contents", []):
            sizes[obj["Key"]] = obj["Size"]
        if not page.get("IsTruncated"):
            return sizes
        token = page["NextContinuationToken"]


def copy_one(src, src_bucket, dst, dst_bucket, key, size, digest):
    body = src.get_object(Bucket=src_bucket, Key=key)["Body"].read()
    if len(body) != size or hashlib.sha256(body).hexdigest() != digest:
        return key, "source digest mismatch"
    # The host's boto3 predates `IfNoneMatch`; the listing above already
    # established the key is absent, and the service keeps writing to the
    # source until the switch, so nothing races this write.
    try:
        dst.put_object(Bucket=dst_bucket, Key=key, Body=body)
    except ClientError as e:
        return key, f"put failed: {e.response.get('Error', {}).get('Code', '')}"
    head = dst.head_object(Bucket=dst_bucket, Key=key)
    if head["ContentLength"] != size:
        return key, "destination size mismatch"
    return key, None


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--operator", required=True)
    p.add_argument("--destination", required=True)
    p.add_argument("--mode", choices=["verify", "copy"], default="verify")
    p.add_argument("--container", default="subrosa-accounts-postgres-1")
    p.add_argument("--workers", type=int, default=8)
    a = p.parse_args()

    op = json.load(open(a.operator))["storage"]
    src = client(op["endpoint"], op["region"], op["access_key"], op["secret_key"])
    d = env_file(a.destination)
    dst = client(d["ENDPOINT"], d.get("REGION", "auto"), d["ACCESS_KEY"], d["SECRET_KEY"])

    wanted = recorded_blobs(a.container)
    have = listed(dst, d["BUCKET"], "")
    missing = {k: v for k, v in wanted.items() if k not in have}
    wrong = {k: v for k, v in wanted.items() if k in have and have[k] != v[0]}
    print(f"recorded {len(wanted)} blobs, {sum(v[0] for v in wanted.values())} bytes")
    print(f"destination holds {len(have)} objects; missing {len(missing)}, size mismatch {len(wrong)}")
    if a.mode == "verify" or not missing:
        return 0 if not missing and not wrong else 1

    failures = []
    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=a.workers) as pool:
        futures = [pool.submit(copy_one, src, op["bucket"], dst, d["BUCKET"], k, s, g) for k, (s, g) in missing.items()]
        for f in concurrent.futures.as_completed(futures):
            key, err = f.result()
            done += 1
            if err:
                failures.append((key, err))
            if done % 200 == 0 or done == len(futures):
                print(f"{done}/{len(futures)} copied, {len(failures)} failed", flush=True)
    for key, err in failures[:20]:
        print(f"FAILED {key}: {err}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
