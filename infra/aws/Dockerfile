# The cloud indexer: the same Python package as the MCP container, on AWS
# Lambda's Python base image. One image, two functions; template.yaml picks the
# handler per function through ImageConfig.Command.
#
# Built by `sam build` from the repository root (DockerContext: ../..), so the
# paths below are relative to the root.
FROM public.ecr.aws/lambda/python:3.11

ENV PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Exact pins, so the indexer runs what the tests ran. boto3 comes with the base image.
COPY requirements.lock.txt /tmp/requirements.lock.txt
RUN pip install --no-cache-dir -r /tmp/requirements.lock.txt && rm /tmp/requirements.lock.txt

# The package itself: src/code_graph -> ${LAMBDA_TASK_ROOT}/code_graph.
COPY src/ ${LAMBDA_TASK_ROOT}/

CMD ["code_graph.etl.aws_lambda.trigger_handler"]
