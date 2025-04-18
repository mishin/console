// Copyright 2022 Redpanda Data, Inc.
//
// Use of this software is governed by the Business Source License
// included in the file https://github.com/redpanda-data/redpanda/blob/dev/licenses/bsl.md
//
// As of the Change Date specified in that file, in accordance with
// the Business Source License, use of this software will be governed
// by the Apache License, Version 2.0

//go:build integration

package api

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	con "github.com/cloudhut/connect-client"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/go-connections/nat"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/network"
	"github.com/testcontainers/testcontainers-go/wait"
	"go.uber.org/zap"

	"github.com/redpanda-data/console/backend/pkg/config"
	"github.com/redpanda-data/console/backend/pkg/connect"
)

func (s *APIIntegrationTestSuite) TestHandleCreateConnector() {
	t := s.T()

	require := require.New(t)
	assert := assert.New(t)

	// setup
	ctx := context.Background()

	// create one common network that all containers will share
	testNetwork, err := network.New(ctx, network.WithCheckDuplicate(), network.WithAttachable())
	require.NoError(err)
	t.Cleanup(func() {
		assert.NoError(testNetwork.Remove(ctx))
	})

	// Redpanda container
	exposedPlainKafkaPort := rand.Intn(50000) + 10000
	exposedOutKafkaPort := rand.Intn(50000) + 10000
	exposedKafkaAdminPort := rand.Intn(50000) + 10000

	redpandaContainer, err := runRedpandaForConnect(ctx, testNetwork.Name, exposedPlainKafkaPort, exposedOutKafkaPort, exposedKafkaAdminPort)
	require.NoError(err)

	// HTTPBin container
	httpC, err := runHTTPBin(ctx, testNetwork.Name)
	require.NoError(err)

	httpBinContainer := httpC

	// Kafka Connect container
	connectC, err := runConnect(testNetwork.Name, []string{"redpanda:" + strconv.FormatInt(int64(exposedPlainKafkaPort), 10)})
	require.NoError(err)

	connectContainer := connectC

	connectPort, err := connectContainer.MappedPort(ctx, nat.Port("8083"))
	require.NoError(err)

	connectHost, err := connectContainer.Host(ctx)
	require.NoError(err)

	// new connect service
	log, err := zap.NewProduction()
	require.NoError(err)

	connectCfg := config.Connect{}
	connectCfg.SetDefaults()
	connectCfg.Enabled = true
	connectCfg.Clusters = []config.ConnectCluster{
		{
			Name: "redpanda_connect",
			URL:  "http://" + connectHost + ":" + connectPort.Port(),
		},
	}

	newConnectSvc, err := connect.NewService(connectCfg, log)
	assert.NoError(err)

	// save old
	oldConnectSvc := s.api.ConnectSvc

	// switch
	s.api.ConnectSvc = newConnectSvc

	// reset connect service
	defer func() {
		s.api.ConnectSvc = oldConnectSvc
	}()

	t.Cleanup(func() {
		assert.NoError(httpBinContainer.Terminate(context.Background()))
		assert.NoError(connectContainer.Terminate(context.Background()))
		assert.NoError(redpandaContainer.Terminate(context.Background()))
	})

	t.Run("happy path", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		input := &createConnectorRequest{
			ConnectorName: "http_connect_input",
			Config: map[string]any{
				"connector.class":                           "com.github.castorm.kafka.connect.http.HttpSourceConnector",
				"header.converter":                          "org.apache.kafka.connect.storage.SimpleHeaderConverter",
				"http.request.url":                          "http://httpbin:80/uuid",
				"http.timer.catchup.interval.millis":        "10000",
				"http.timer.interval.millis":                "1000",
				"kafka.topic":                               "httpbin-input",
				"key.converter":                             "org.apache.kafka.connect.json.JsonConverter",
				"key.converter.schemas.enable":              "false",
				"name":                                      "http_connect_input",
				"topic.creation.default.partitions":         "1",
				"topic.creation.default.replication.factor": "1",
				"topic.creation.enable":                     "true",
				"value.converter":                           "org.apache.kafka.connect.json.JsonConverter",
				"value.converter.schemas.enable":            "false",
			},
		}

		res, body := s.apiRequest(ctx, http.MethodPost, "/api/kafka-connect/clusters/redpanda_connect/connectors", input)

		require.Equal(200, res.StatusCode)

		createConnectRes := con.ConnectorInfo{}
		err := json.Unmarshal(body, &createConnectRes)
		require.NoError(err)

		assert.Equal("http_connect_input", createConnectRes.Name)
		assert.Equal("httpbin-input", createConnectRes.Config["kafka.topic"])
		assert.Equal("1000", createConnectRes.Config["http.timer.interval.millis"])
	})
}

const testConnectConfig = `key.converter=org.apache.kafka.connect.converters.ByteArrayConverter
value.converter=org.apache.kafka.connect.converters.ByteArrayConverter
group.id=connectors-cluster
offset.storage.topic=_internal_connectors_offsets
config.storage.topic=_internal_connectors_configs
status.storage.topic=_internal_connectors_status
config.storage.replication.factor=-1
offset.storage.replication.factor=-1
status.storage.replication.factor=-1
`

func runConnect(network string, bootstrapServers []string) (testcontainers.Container, error) {
	const waitTimeout = 5 * time.Minute
	ctx, cancel := context.WithTimeout(context.Background(), waitTimeout)
	defer cancel()

	return testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:        "docker.cloudsmith.io/redpanda/connectors-unsupported/connectors:v1.0.0-3d7ab4d",
			ExposedPorts: []string{strconv.FormatInt(int64(nat.Port("8083/tcp").Int()), 10)},
			Env: map[string]string{
				"CONNECT_CONFIGURATION":     testConnectConfig,
				"CONNECT_BOOTSTRAP_SERVERS": strings.Join(bootstrapServers, ","),
				"CONNECT_GC_LOG_ENABLED":    "false",
				"CONNECT_HEAP_OPTS":         "-Xms512M -Xmx512M",
				"CONNECT_LOG_LEVEL":         "info",
			},
			Networks: []string{
				network,
			},
			NetworkAliases: map[string][]string{
				network: {"redpanda-connect"},
			},
			Hostname: "redpanda-connect",
			WaitingFor: wait.ForAll(
				wait.ForLog("Kafka Connect started").
					WithPollInterval(500 * time.Millisecond).
					WithStartupTimeout(waitTimeout),
			),
		},
		Started: true,
	})
}

func runRedpandaForConnect(ctx context.Context, network string, plaintextKafkaPort, outsideKafkaPort, exposedKafkaAdminPort int) (testcontainers.Container, error) {
	plainKafkaPort := strconv.FormatInt(int64(plaintextKafkaPort), 10)
	outKafkaPort := strconv.FormatInt(int64(outsideKafkaPort), 10)
	kafkaAdminPort := strconv.FormatInt(int64(exposedKafkaAdminPort), 10)
	registryPort := strconv.FormatInt(int64(rand.Intn(50000)+10000), 10)

	req := testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Hostname:       "redpanda",
			Networks:       []string{network},
			NetworkAliases: map[string][]string{network: {"redpanda", "local-redpanda"}},
			Image:          "docker.redpanda.com/redpandadata/redpanda:v23.2.18",
			ExposedPorts: []string{
				plainKafkaPort,
				outKafkaPort,
				kafkaAdminPort,
				registryPort,
			},
			Cmd: []string{
				"redpanda start",
				"--smp 1",
				"--overprovisioned",
				fmt.Sprintf("--kafka-addr PLAINTEXT://0.0.0.0:%s,OUTSIDE://0.0.0.0:%s", plainKafkaPort, outKafkaPort),
				fmt.Sprintf("--advertise-kafka-addr PLAINTEXT://redpanda:%s,OUTSIDE://localhost:%s", plainKafkaPort, outKafkaPort),
			},
			HostConfigModifier: func(hostConfig *container.HostConfig) {
				hostConfig.PortBindings = nat.PortMap{
					nat.Port(outKafkaPort + "/tcp"): []nat.PortBinding{
						{
							HostIP:   "",
							HostPort: strconv.FormatInt(int64(nat.Port(outKafkaPort+"/tcp").Int()), 10),
						},
					},
					nat.Port(kafkaAdminPort + "/tcp"): []nat.PortBinding{
						{
							HostIP:   "",
							HostPort: strconv.FormatInt(int64(nat.Port(kafkaAdminPort+"/tcp").Int()), 10),
						},
					},
					nat.Port(registryPort + "/tcp"): []nat.PortBinding{
						{
							HostIP:   "",
							HostPort: strconv.FormatInt(int64(nat.Port(registryPort+"/tcp").Int()), 10),
						},
					},
					nat.Port(plainKafkaPort + "/tcp"): []nat.PortBinding{
						{
							HostIP:   "",
							HostPort: strconv.FormatInt(int64(nat.Port(plainKafkaPort+"/tcp").Int()), 10),
						},
					},
				}
			},
		},
		Started: true,
	}

	container, err := testcontainers.GenericContainer(ctx, req)
	if err != nil {
		return nil, err
	}

	err = wait.ForLog("Successfully started Redpanda!").
		WithPollInterval(100*time.Millisecond).
		WaitUntilReady(ctx, container)
	if err != nil {
		return nil, fmt.Errorf("failed to wait for Redpanda readiness: %w", err)
	}

	return container, nil
}

func runHTTPBin(ctx context.Context, network string) (testcontainers.Container, error) {
	req := testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Hostname:       "httpbin",
			Networks:       []string{network},
			NetworkAliases: map[string][]string{network: {"httpbin", "local-httpbin"}},
			Image:          "kennethreitz/httpbin",
			ExposedPorts:   []string{"80/tcp"},
			WaitingFor:     wait.ForHTTP("/"),
		},
		Started: true,
	}

	container, err := testcontainers.GenericContainer(ctx, req)
	if err != nil {
		return nil, err
	}

	return container, nil
}
