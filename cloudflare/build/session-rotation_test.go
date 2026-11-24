package v4

import (
	"bytes"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
)

func TestRotatedR2Session(t *testing.T) {
	timestamp := NewSigningTime(time.Now())
	first := aws.Credentials{AccessKeyID: "parent", SecretAccessKey: "first", SessionToken: "first-session"}
	second := aws.Credentials{AccessKeyID: "parent", SecretAccessKey: "second", SessionToken: "second-session"}

	signer := NewSigningKeyDeriver()
	old := signer.DeriveKey(first, "s3", "auto", timestamp)
	got := signer.DeriveKey(second, "s3", "auto", timestamp)
	want := NewSigningKeyDeriver().DeriveKey(second, "s3", "auto", timestamp)
	if bytes.Equal(old, got) || !bytes.Equal(got, want) {
		t.Fatal("the next session must use its own signing key")
	}
}
