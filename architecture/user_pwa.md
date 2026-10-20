# User PWA Architecture

Describes a screen flow for the basic CaCi user PWA.

The application should be very minimal, all functionality should be accessed via APIs implemented on the CaCi service. The API should be exactly the same as the Admin webapp, ensuring consistency and reducing the need for duplicate logic.

## Screen Flow

```
---------    --------    ------------
|       |    |      |    |          |
| Login | -> | Home | -> | Profile  | 
|       |    |      |    | Settings |
---------    --------    ------------
```

## Home Screen

For the Home Sceen I would like to experiment with CaCi, as a chat interface, like iMessage. This is fairly simple and flexible for initial use, allowing different questions and updats to be asked via the <update field>. 

When send is clicked, CaCi should ask if this is an update for you or a circle, then the filing should target the appropriate brain, with a note "recorded against user brain" or "recorded against circle brain" accordingly.

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