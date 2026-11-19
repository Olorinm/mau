import { expect, it } from "vitest";
import { ageKeyPair, generateAgeKeyPair } from "../src/deploy/age.js";
import { signS3 } from "../src/deploy/s3.js";
import { inspectCodexAuth, parseJsonc } from "../src/deploy/source.js";
import { configRevision } from "../src/deploy/state.js";
import { parseDeployArgs, parseDoctorArgs } from "../src/deploy/index.js";

it("signs S3 requests as AWS's published Signature Version 4 example", () => {
  // "GET Object" of https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
  const headers = signS3({ endpoint: "https://examplebucket.s3.amazonaws.com", region: "us-east-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
    "GET", new URL("https://examplebucket.s3.amazonaws.com/test.txt"), { Range: "bytes=0-9" }, new Uint8Array(), new Date("2013-05-24T00:00:00Z"));
  expect(headers.authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
    .replaceAll(",S", ", S"));
  // "GET Bucket (List Objects)" of the same page: a query string is part of what is signed.
  const listing = signS3({ endpoint: "https://examplebucket.s3.amazonaws.com", region: "us-east-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
    "GET", new URL("https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J"), {}, new Uint8Array(), new Date("2013-05-24T00:00:00Z"));
  expect(listing.authorization).toContain("Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
});

it("makes age key pairs the age tools accept", () => {
  // `age-keygen -y` prints this recipient for this identity.
  expect(ageKeyPair(Buffer.alloc(32, 7))).toEqual({ recipient: "age1zwlyl6h27gzv0lfntr7fcqrjrzqazap8sy5zylkxwneh7llf0dksu37mwt",
    identity: "AGE-SECRET-KEY-1QURSWPC8QURSWPC8QURSWPC8QURSWPC8QURSWPC8QURSWPC8QURSKMP32K" });
  const pair = generateAgeKeyPair();
  expect(pair.recipient).toMatch(/^age1[0-9a-z]{58}$/);
  expect(pair.identity).not.toBe(generateAgeKeyPair().identity);
});

it("reads Wrangler's commented examples and tells a usable Codex sign-in without showing it", () => {
  expect(parseJsonc(`{ // a comment\n "url": "https://example.com/a//b", /* block */ "list": [1, 2,], "text": "a \\" // not a comment",\n}`))
    .toEqual({ url: "https://example.com/a//b", list: [1, 2], text: "a \" // not a comment" });
  const jwt = (exp: number) => `e30.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
  const now = Date.parse("2026-11-19T00:00:00Z"), bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
  expect(inspectCodexAuth(Buffer.from("not json"), now)).toEqual({ ok: false, detail: "not a JSON document" });
  expect(inspectCodexAuth(bytes({}), now)).toEqual({ ok: false, detail: "holds no sign-in" });
  expect(inspectCodexAuth(bytes({ OPENAI_API_KEY: "key" }), now)).toEqual({ ok: true, detail: "signed in with an API key" });
  expect(inspectCodexAuth(bytes({ tokens: { access_token: jwt(1), refresh_token: "refresh" } }), now).ok).toBe(true);
  expect(inspectCodexAuth(bytes({ tokens: { access_token: jwt(1) } }), now)).toEqual({ ok: false, detail: "access token expires 1970-01-01T00:00:01.000Z and there is no refresh token" });
  expect(JSON.stringify(inspectCodexAuth(bytes({ tokens: { access_token: jwt(4102444800), refresh_token: "refresh" } }), now))).not.toMatch(/signature|refresh"/);
});

it("derives one configuration revision from every object, and reads its flags", () => {
  const files = new Map([["mau.json", Buffer.from("{}")], ["cloud/start-host.sh", Buffer.from("#!/bin/sh")]]);
  expect(configRevision(files)).toBe(configRevision(new Map([...files].reverse())));
  expect(configRevision(files)).not.toBe(configRevision(new Map([...files, ["extra", Buffer.from("")]])));
  expect(configRevision(files)).not.toBe(configRevision(new Map([["mau.json", Buffer.from("{ }")], ["cloud/start-host.sh", Buffer.from("#!/bin/sh")]])));
  expect(parseDeployArgs(["--hostname", "mau.example.com", "--owner-email", "owner@example.com", "--dry-run"])).toEqual({ hostname: "mau.example.com", ownerEmail: "owner@example.com", dryRun: true });
  expect(parseDeployArgs(["--name", "team", "--access-team-domain", "https://t.cloudflareaccess.com", "--access-audience", "aud", "--r2-access-key-id-file", "a", "--r2-secret-access-key-file", "b", "--codex-auth", "c", "--dir", "d"]))
    .toEqual({ name: "team", accessTeamDomain: "https://t.cloudflareaccess.com", accessAudience: "aud", r2AccessKeyIdFile: "a", r2SecretAccessKeyFile: "b", codexAuth: "c", dir: "d" });
  expect(parseDoctorArgs(["--url", "https://mau.example.com"])).toEqual({ url: "https://mau.example.com" });
  expect(() => parseDeployArgs(["--unknown"])).toThrow();
});
