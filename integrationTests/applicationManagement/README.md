# Application Management Integration Tests

A key part of Harper's functionality is application management, which includes deployment, installation, loading, updating, etc.

There are many key scenarios to evaluate and the system is rapidly evolving.

The testing scenarios may be complex and sometimes even take a long time to execute (e.g., installing large applications, handling network failures, etc.). In the ideal future, we could use Harper Fabric to efficiently parallelize and distribute these tests across multiple Harper instances all at once. This would allow us to reliably test independent scenarios in isolation, without interference from other tests. This concept has some complexities such as monetary cost and local execution. Whatever we create here should reliably work both locally and in CI/CD environments. Open source users should be able to run these tests on their local machines without needing to set up multiple Harper instances or incur costs. And then repository maintainers should be able to run these tests on PRs within the GitHub actions workflow.

For now, we will start with a more straightforward approach. We will create a single Harper instance and run the tests sequentially against it. This is simpler to implement and maintain, although it may be slower and less reliable than a distributed approach. However, it allows us to get started quickly and validate the core functionality of application management in Harper. We may omit more complex scenarios for now, focusing on the most critical ones. As we gain more experience and confidence with this approach, we can consider expanding to a more distributed testing strategy in the future.

Furthermore, there may be a solution where we can parallelize execution via multiple GitHub runners since we've had decent success running Harper directly within GitHub actions. One drawback is managing multiple runners and collecting all of their results is non-trivial.

## Scenarios

### Basic Application Deployment

- Deploy a simple application from local filesystem
- Deploy a simple application from a remote Git repository
- Deploy a simple application from npm registry

### Private Repository Access

- Deploy an application from a private Git repository using SSH keys
- Deploy an application from a private npm package using authentication tokens

## Running the Tests

