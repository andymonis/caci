# User PWA Architecture

Describes a screen flow for the basic CaCi user PWA.

The application should be very minimal, all functionality should be accessed via APIs implemented on the CaCi service. The API should be exactly the same as the Admin webapp, ensuring consistency and reducing the need for duplicate logic.

## Screen Flow

```
---------    --------     ------------
|       |    |      |     |          |
| Login | -> | Home | |-> | Profile  | 
|       |    |      | |   | Settings |
---------    -------- |   ------------
                      |
                      |-> ------------
                          | Circle   |
                          ------------
```

## Home Screen

For the Home Sceen I would like to experiment with CaCi, as a chat interface, like iMessage. This is fairly simple and flexible for initial use, allowing different questions and updats to be asked via the <update field>. 

When send is clicked, CaCi should record the update against the user's brain. 

When the ask button is clicked, CaCi should process the question and provide a response based on the combined context of the user's brain and the circle's brain, depending on the context.

```
-----------------------------------
|            CaCi                 |
|          User name              |
|---------------------------------|
|              "update from user" |
| "response from CaCi"            |
|              "update from user" |
| "response from CaCi"            |
|                 "status update" |
| "status response from CaCi"     |
|---------------------------------|
|         | <update field> | send |
|        | <question field> | ask |
-----------------------------------
```

## Circle Screen

The Circle screen allows users to interact with the circle's brain, similar to the Home screen but focused on circle-specific updates and questions.

When an update is made from the circle screen, CaCi should record it against the circle's brain, ensuring that the context is maintained separately from the user's brain.

When the pulse button is clicked, the app should ask for a status update, using predefined text, to provide a fast and efficent and consistent way to gather circle status information.

The pulse text should be configurable as a system property from a file. Suggest "provide a status update for the circle. Keep answer factual, stick to the point and be concise."

```
-----------------------------------
|            CaCi                 |
|          Circle name            |
|---------------------------------|
|              "update from user" |
| "response from CaCi"            |
|              "update from user" |
| "response from CaCi"            |
|                 "pulse button"  |
| "status response from CaCi"     |
|---------------------------------|
|         | <update field> | send |
|                < pulse button > |
-----------------------------------
```