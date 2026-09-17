import uuid

from chat_engine import get_chat_engine


def main():
    session_id = str(uuid.uuid4())
    chat_engine = get_chat_engine(session_id)

    print("Chat ready. Type 'exit' to quit.\n")
    while True:
        message = input("you> ").strip()
        if message.lower() in ("exit", "quit"):
            break
        if not message:
            continue

        print("bot> ", end="", flush=True)
        response = chat_engine.stream_chat(message)
        for token in response.response_gen:
            print(token, end="", flush=True)
        print("\n")


if __name__ == "__main__":
    main()
