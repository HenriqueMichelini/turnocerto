package schedule

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (roundTrip roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return roundTrip(request)
}

func TestTurnstileVerifierSendsCredentialsOnlyToSiteverifyAndChecksHostname(t *testing.T) {
	const secret = "private-test-secret"
	const token = "single-use-turnstile-proof"
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.String() != turnstileSiteverifyURL || request.Method != http.MethodPost {
			t.Fatalf("Siteverify request target = %s %s", request.Method, request.URL)
		}
		if got := request.Header.Get("Content-Type"); got != "application/json" {
			t.Fatalf("Siteverify Content-Type = %q, want application/json", got)
		}
		var body struct {
			Secret   string `json:"secret"`
			Response string `json:"response"`
			RemoteIP string `json:"remoteip"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatalf("decode Siteverify request: %v", err)
		}
		if body.Secret != secret || body.Response != token || body.RemoteIP != "198.51.100.42" {
			t.Fatalf("Siteverify request payload = %#v, want secret, challenge token, and client IP", body)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(`{"success":true,"hostname":"preview.turnocerto.pages.dev"}`)),
			Header:     make(http.Header),
		}, nil
	})}
	verifier := &turnstileVerifier{secretKey: secret, client: client}

	verified, err := verifier.Verify(context.Background(), token, "198.51.100.42", "preview.turnocerto.pages.dev")
	if err != nil || !verified {
		t.Fatalf("Verify() = %v, %v; want true, nil", verified, err)
	}
	verified, err = verifier.Verify(context.Background(), token, "198.51.100.42", "turnocerto.pages.dev")
	if err != nil || verified {
		t.Fatalf("Verify() with an unconfigured hostname = %v, %v; want false, nil", verified, err)
	}
}

func TestTurnstileVerifierRejectsInvalidTokensAndFailsClosedWhenUnavailable(t *testing.T) {
	for _, test := range []struct {
		name      string
		status    int
		body      string
		transport error
		wantValid bool
		wantErr   bool
	}{
		{name: "invalid, expired, or replayed challenge", status: http.StatusOK, body: `{"success":false}`, wantValid: false},
		{name: "provider rejects non-200 response", status: http.StatusServiceUnavailable, body: `{"success":false}`, wantErr: true},
		{name: "provider is unreachable", transport: context.DeadlineExceeded, wantErr: true},
		{name: "provider response is malformed", status: http.StatusOK, body: `not-json`, wantErr: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				if test.transport != nil {
					return nil, test.transport
				}
				return &http.Response{
					StatusCode: test.status,
					Body:       io.NopCloser(strings.NewReader(test.body)),
					Header:     make(http.Header),
				}, nil
			})}
			verifier := &turnstileVerifier{secretKey: "private-test-secret", client: client}
			verified, err := verifier.Verify(context.Background(), "challenge-token", "198.51.100.42", "preview.turnocerto.pages.dev")
			if verified != test.wantValid || (err != nil) != test.wantErr {
				t.Fatalf("Verify() = %v, %v; want %v, error=%v", verified, err, test.wantValid, test.wantErr)
			}
			if err != nil && (strings.Contains(err.Error(), "challenge-token") || strings.Contains(err.Error(), "private-test-secret")) {
				t.Fatalf("verification error exposed a credential: %v", err)
			}
		})
	}

	missingSecret := &turnstileVerifier{secretKey: "", client: &http.Client{}}
	if verified, err := missingSecret.Verify(context.Background(), "challenge-token", "", "preview.turnocerto.pages.dev"); err == nil || verified {
		t.Fatalf("Verify() without a configured secret = %v, %v; want false and an error", verified, err)
	}
}
