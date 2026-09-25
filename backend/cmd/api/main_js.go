//go:build js && wasm

package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"syscall/js"

	"github.com/HenriqueMichelini/turnocerto/backend/internal/schedule"
)

const scheduleQuery = `SELECT schedules.id, schedules.name,
       management_spaces.id AS managementSpaceId,
       management_spaces.name AS managementSpaceName
FROM schedules
INNER JOIN management_spaces ON management_spaces.id = schedules.management_space_id
WHERE schedules.id = ?`

const renameScheduleQuery = `UPDATE schedules
SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = ?`

type d1Store struct {
	database js.Value
}

type promiseResult struct {
	value js.Value
	err   error
}

type workerResponse struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (response *workerResponse) Header() http.Header {
	return response.header
}

func (response *workerResponse) WriteHeader(status int) {
	if response.status == 0 {
		response.status = status
	}
}

func (response *workerResponse) Write(body []byte) (int, error) {
	if response.status == 0 {
		response.status = http.StatusOK
	}
	return response.body.Write(body)
}

var workerFetch js.Func

func main() {
	workerFetch = js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) < 2 {
			return newPromise(func(_ js.Value, callbacks []js.Value) any {
				callbacks[1].Invoke("Invalid Worker request")
				return nil
			})
		}
		request, env := args[0], args[1]
		return newPromise(func(_ js.Value, callbacks []js.Value) any {
			resolve := callbacks[0]
			go func() {
				resolve.Invoke(handleRequest(request, env))
			}()
			return nil
		})
	})
	js.Global().Set("turnocertoFetch", workerFetch)
	select {}
}

func newPromise(executor func(js.Value, []js.Value) any) js.Value {
	function := js.FuncOf(executor)
	promise := js.Global().Get("Promise").New(function)
	function.Release()
	return promise
}

func handleRequest(requestValue, env js.Value) (response js.Value) {
	defer func() {
		if recover() != nil {
			response = failureResponse(requestValue, env)
		}
	}()

	method := requestValue.Get("method").String()
	url := requestValue.Get("url").String()
	body := ""
	if method == http.MethodPatch {
		bodyValue, err := awaitPromise(requestValue.Call("text"))
		if err != nil {
			return failureResponse(requestValue, env)
		}
		body = bodyValue.String()
	}

	request, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		return failureResponse(requestValue, env)
	}
	request.Header.Set("Content-Type", headerValue(requestValue, "content-type"))
	request.Header.Set("Origin", headerValue(requestValue, "origin"))
	if length := headerValue(requestValue, "content-length"); length != "" {
		request.Header.Set("Content-Length", length)
	}
	if accept := headerValue(requestValue, "accept"); accept != "" {
		request.Header.Set("Accept", accept)
	}
	if authorization := headerValue(requestValue, "authorization"); authorization != "" {
		request.Header.Set("Authorization", authorization)
	}

	store := d1Store{database: env.Get("DB")}
	appEnv := env.Get("APP_ENV").String()
	webOrigin := env.Get("WEB_ORIGIN").String()
	previewTokenHash := env.Get("PREVIEW_TOKEN_HASH").String()
	handler := schedule.NewHTTPHandler(store, appEnv, webOrigin, previewTokenHash)
	responseRecorder := &workerResponse{header: make(http.Header)}
	handler.ServeHTTP(responseRecorder, request)
	status := responseRecorder.status
	if status == 0 {
		status = http.StatusOK
	}
	return jsResponse(status, responseRecorder.Header(), responseRecorder.body.Bytes())
}

func (store d1Store) GetSchedule(_ context.Context, id string) (schedule.Schedule, error) {
	statement := store.database.Call("prepare", scheduleQuery).Call("bind", id)
	row, err := awaitPromise(statement.Call("first"))
	if err != nil {
		return schedule.Schedule{}, err
	}
	if row.IsNull() || row.IsUndefined() {
		return schedule.Schedule{}, schedule.ErrNotFound
	}
	return schedule.Schedule{
		ID:   row.Get("id").String(),
		Name: row.Get("name").String(),
		ManagementSpace: schedule.ManagementSpace{
			ID:   row.Get("managementSpaceId").String(),
			Name: row.Get("managementSpaceName").String(),
		},
	}, nil
}

func (store d1Store) RenameSchedule(ctx context.Context, id, name string) (schedule.Schedule, error) {
	statement := store.database.Call("prepare", renameScheduleQuery).Call("bind", name, id)
	result, err := awaitPromise(statement.Call("run"))
	if err != nil {
		return schedule.Schedule{}, err
	}
	changes, err := safeNumber(result.Get("meta").Get("changes"))
	if err != nil {
		return schedule.Schedule{}, err
	}
	if changes != 1 {
		return schedule.Schedule{}, schedule.ErrNotFound
	}
	return store.GetSchedule(ctx, id)
}

func awaitPromise(promise js.Value) (js.Value, error) {
	result := make(chan promiseResult, 1)
	resolved := js.FuncOf(func(_ js.Value, values []js.Value) any {
		if len(values) == 0 {
			result <- promiseResult{err: errors.New("promise resolved without a value")}
		} else {
			result <- promiseResult{value: values[0]}
		}
		return nil
	})
	rejected := js.FuncOf(func(_ js.Value, values []js.Value) any {
		message := "promise rejected"
		if len(values) > 0 {
			message = values[0].String()
		}
		result <- promiseResult{err: errors.New(message)}
		return nil
	})
	promise.Call("then", resolved).Call("catch", rejected)
	outcome := <-result
	resolved.Release()
	rejected.Release()
	return outcome.value, outcome.err
}

func safeNumber(value js.Value) (number int, err error) {
	defer func() {
		if recover() != nil {
			err = fmt.Errorf("invalid numeric result")
		}
	}()
	return value.Int(), nil
}

func headerValue(request js.Value, name string) string {
	value := request.Get("headers").Call("get", name)
	if value.IsNull() || value.IsUndefined() {
		return ""
	}
	return value.String()
}

func jsResponse(status int, headers http.Header, body []byte) js.Value {
	jsHeaders := js.Global().Get("Object").New()
	for name, values := range headers {
		jsHeaders.Set(name, strings.Join(values, ", "))
	}
	options := js.Global().Get("Object").New()
	options.Set("status", status)
	options.Set("headers", jsHeaders)
	var responseBody any = string(body)
	if status == http.StatusNoContent {
		responseBody = js.Null()
	}
	return js.Global().Get("Response").New(responseBody, options)
}

func failureResponse(request, env js.Value) js.Value {
	headers := js.Global().Get("Object").New()
	headers.Set("Cache-Control", "private, no-store, max-age=0")
	headers.Set("Content-Type", "application/json; charset=utf-8")
	headers.Set("Expires", "0")
	headers.Set("Pragma", "no-cache")
	headers.Set("Referrer-Policy", "no-referrer")
	headers.Set("X-Content-Type-Options", "nosniff")
	headers.Set("X-Robots-Tag", "noindex, nofollow, noarchive")
	if origin := headerValue(request, "origin"); origin != "" && origin == env.Get("WEB_ORIGIN").String() {
		headers.Set("Access-Control-Allow-Origin", origin)
		headers.Set("Access-Control-Allow-Methods", "GET, PATCH, OPTIONS")
		headers.Set("Access-Control-Allow-Headers", "Accept, Authorization, Content-Type")
		headers.Set("Access-Control-Max-Age", "600")
		headers.Set("Vary", "Origin")
	}
	options := js.Global().Get("Object").New()
	options.Set("status", http.StatusServiceUnavailable)
	options.Set("headers", headers)
	return js.Global().Get("Response").New(`{"error":"temporarily_unavailable"}`, options)
}
