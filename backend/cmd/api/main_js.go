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

const createManagementSpaceQuery = `INSERT INTO management_spaces (id, name, management_token_hash)
VALUES (?, ?, ?)`

const createManagementScheduleQuery = `INSERT INTO schedules (id, management_space_id, name)
VALUES (?, ?, ?)`

const renameManagementSpaceQuery = `UPDATE management_spaces
SET name = ?
WHERE id = ?`

const getManagementSpaceNameQuery = `SELECT id, name
FROM management_spaces
WHERE id = ?`

const getManagementSpaceQuery = `SELECT management_spaces.id AS managementSpaceId,
       management_spaces.name AS managementSpaceName,
       schedules.id AS scheduleId,
       schedules.name AS scheduleName
FROM management_spaces
LEFT JOIN schedules ON schedules.management_space_id = management_spaces.id
WHERE management_spaces.id = ? AND management_spaces.management_token_hash = ?
ORDER BY schedules.rowid`

const renameManagementScheduleQuery = `UPDATE schedules
SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = ? AND management_space_id = ?`

const getManagementScheduleQuery = `SELECT schedules.id, schedules.name,
       management_spaces.id AS managementSpaceId,
       management_spaces.name AS managementSpaceName
FROM schedules
INNER JOIN management_spaces ON management_spaces.id = schedules.management_space_id
WHERE schedules.id = ? AND management_spaces.id = ?`

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

type cloudflareRateLimiter struct {
	binding js.Value
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
	if method == http.MethodPatch || method == http.MethodPost {
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
	if clientIP := headerValue(requestValue, "cf-connecting-ip"); clientIP != "" {
		request.Header.Set("CF-Connecting-IP", clientIP)
	}

	store := d1Store{database: env.Get("DB")}
	appEnv := environmentValue(env, "APP_ENV")
	webOrigin := environmentValue(env, "WEB_ORIGIN")
	previewTokenHash := environmentValue(env, "PREVIEW_TOKEN_HASH")
	security := schedule.ManagementSecurity{
		ChallengeVerifier: schedule.NewTurnstileVerifier(environmentValue(env, "TURNSTILE_SECRET_KEY")),
		CreationRateLimiter: cloudflareRateLimiter{
			binding: env.Get("CREATION_RATE_LIMITER"),
		},
		ChallengeHostname: environmentValue(env, "TURNSTILE_ALLOWED_HOSTNAME"),
	}
	handler := schedule.NewHTTPHandlerWithManagement(store, store, appEnv, webOrigin, previewTokenHash, security)
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
	if err := store.runPreparedUpdate(renameScheduleQuery, name, id); err != nil {
		return schedule.Schedule{}, err
	}
	return store.GetSchedule(ctx, id)
}

func (store d1Store) CreateManagementSpace(_ context.Context, managementSpace schedule.ManagementSpace, firstSchedule schedule.Schedule, tokenHash string) error {
	statements := js.Global().Get("Array").New()
	statements.Call("push", store.database.Call("prepare", createManagementSpaceQuery).Call("bind", managementSpace.ID, managementSpace.Name, tokenHash))
	statements.Call("push", store.database.Call("prepare", createManagementScheduleQuery).Call("bind", firstSchedule.ID, managementSpace.ID, firstSchedule.Name))
	if _, err := awaitPromise(store.database.Call("batch", statements)); err != nil {
		return err
	}
	return nil
}

func (store d1Store) GetManagementSpace(_ context.Context, id, tokenHash string) (schedule.ManagementSpaceView, error) {
	statement := store.database.Call("prepare", getManagementSpaceQuery).Call("bind", id, tokenHash)
	result, err := awaitPromise(statement.Call("all"))
	if err != nil {
		return schedule.ManagementSpaceView{}, err
	}
	rows := result.Get("results")
	if rows.IsUndefined() || rows.IsNull() || rows.Length() == 0 {
		return schedule.ManagementSpaceView{}, schedule.ErrUnauthorized
	}
	first := rows.Index(0)
	managementSpace := schedule.ManagementSpace{
		ID:   first.Get("managementSpaceId").String(),
		Name: first.Get("managementSpaceName").String(),
	}
	view := schedule.ManagementSpaceView{ManagementSpace: managementSpace, Schedules: make([]schedule.Schedule, 0, rows.Length())}
	for index := 0; index < rows.Length(); index++ {
		row := rows.Index(index)
		scheduleID := row.Get("scheduleId")
		if scheduleID.IsNull() || scheduleID.IsUndefined() {
			continue
		}
		view.Schedules = append(view.Schedules, schedule.Schedule{
			ID:              scheduleID.String(),
			Name:            row.Get("scheduleName").String(),
			ManagementSpace: managementSpace,
		})
	}
	return view, nil
}

func (store d1Store) RenameManagementSpace(_ context.Context, id, name string) (schedule.ManagementSpace, error) {
	if err := store.runPreparedUpdate(renameManagementSpaceQuery, name, id); err != nil {
		return schedule.ManagementSpace{}, err
	}
	row, err := store.firstPreparedRow(getManagementSpaceNameQuery, id)
	if err != nil {
		return schedule.ManagementSpace{}, err
	}
	if row.IsNull() || row.IsUndefined() {
		return schedule.ManagementSpace{}, schedule.ErrNotFound
	}
	return schedule.ManagementSpace{ID: row.Get("id").String(), Name: row.Get("name").String()}, nil
}

func (store d1Store) RenameManagementSchedule(ctx context.Context, spaceID, scheduleID, name string) (schedule.Schedule, error) {
	if err := store.runPreparedUpdate(renameManagementScheduleQuery, name, scheduleID, spaceID); err != nil {
		return schedule.Schedule{}, err
	}
	row, err := store.firstPreparedRow(getManagementScheduleQuery, scheduleID, spaceID)
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

func (store d1Store) runPreparedUpdate(query string, bindings ...any) error {
	statement := store.database.Call("prepare", query).Call("bind", bindings...)
	result, err := awaitPromise(statement.Call("run"))
	if err != nil {
		return err
	}
	changes, err := safeNumber(result.Get("meta").Get("changes"))
	if err != nil {
		return err
	}
	if changes != 1 {
		return schedule.ErrNotFound
	}
	return nil
}

func (store d1Store) firstPreparedRow(query string, bindings ...any) (js.Value, error) {
	statement := store.database.Call("prepare", query).Call("bind", bindings...)
	return awaitPromise(statement.Call("first"))
}

func (limiter cloudflareRateLimiter) Allow(_ context.Context, key string) (bool, error) {
	if limiter.binding.IsUndefined() || limiter.binding.IsNull() {
		return false, errors.New("creation rate limit binding is not configured")
	}
	options := js.Global().Get("Object").New()
	options.Set("key", key)
	result, err := awaitPromise(limiter.binding.Call("limit", options))
	if err != nil {
		return false, err
	}
	success := result.Get("success")
	if success.Type() != js.TypeBoolean {
		return false, errors.New("creation rate limit returned an invalid result")
	}
	return success.Bool(), nil
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

func environmentValue(env js.Value, name string) string {
	value := env.Get(name)
	if value.IsUndefined() || value.IsNull() {
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
		headers.Set("Access-Control-Allow-Methods", "GET, PATCH, POST, OPTIONS")
		headers.Set("Access-Control-Allow-Headers", "Accept, Authorization, Content-Type")
		headers.Set("Access-Control-Max-Age", "600")
		headers.Set("Vary", "Origin")
	}
	options := js.Global().Get("Object").New()
	options.Set("status", http.StatusServiceUnavailable)
	options.Set("headers", headers)
	return js.Global().Get("Response").New(`{"error":"temporarily_unavailable"}`, options)
}
