import json
import logging
import uuid


_LOG = logging.getLogger("uvicorn.error")
_LOGGED_PATHS = {"/v1/systemone", "/v1/systemone/batch"}


def _body_for_log(body: bytes) -> str:
    try:
        return json.dumps(json.loads(body), ensure_ascii=False, separators=(",", ":"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return repr(body)


class RequestResponseLogger:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or scope.get("path") not in _LOGGED_PATHS:
            await self.app(scope, receive, send)
            return

        request_id = uuid.uuid4().hex[:8]
        request_body = bytearray()
        response_body = bytearray()
        request_logged = False
        status = None

        async def logged_receive():
            nonlocal request_logged
            message = await receive()
            if message["type"] == "http.request":
                request_body.extend(message.get("body", b""))
                if not request_logged and not message.get("more_body", False):
                    _LOG.info(
                        "request id=%s method=%s path=%s body=%s",
                        request_id,
                        scope.get("method", ""),
                        scope.get("path", ""),
                        _body_for_log(bytes(request_body)),
                    )
                    request_logged = True
            return message

        async def logged_send(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
            elif message["type"] == "http.response.body":
                response_body.extend(message.get("body", b""))
            await send(message)
            if message["type"] == "http.response.body" and not message.get("more_body", False):
                _LOG.info(
                    "response id=%s path=%s status=%s body=%s",
                    request_id,
                    scope.get("path", ""),
                    status,
                    _body_for_log(bytes(response_body)),
                )

        await self.app(scope, logged_receive, logged_send)


def main():
    from laya import serve

    create_app = serve.create_app
    serve.create_app = lambda *args, **kwargs: RequestResponseLogger(create_app(*args, **kwargs))
    serve.main()


if __name__ == "__main__":
    main()
