package com.example.querylab.config;

import com.example.querylab.metrics.QueryMetrics;
import java.util.List;
import java.util.Locale;
import javax.sql.DataSource;
import net.ttddyy.dsproxy.ExecutionInfo;
import net.ttddyy.dsproxy.QueryInfo;
import net.ttddyy.dsproxy.listener.QueryExecutionListener;
import net.ttddyy.dsproxy.support.ProxyDataSourceBuilder;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
public class JdbcObservationConfig {
    @Bean
    public static BeanPostProcessor observedDataSources(ObjectProvider<QueryMetrics> metrics) {
        return new BeanPostProcessor() {
            @Override
            public Object postProcessAfterInitialization(Object bean, String name) {
                if (!(bean instanceof DataSource source)) {
                    return bean;
                }

                QueryExecutionListener listener = new QueryExecutionListener() {
                    @Override
                    public void beforeQuery(ExecutionInfo info, List<QueryInfo> queries) {
                        // Measurement is recorded after the JDBC execute call returns.
                    }

                    @Override
                    public void afterQuery(ExecutionInfo info, List<QueryInfo> queries) {
                        for (QueryInfo query : queries) {
                            String sql = query.getQuery();
                            if (sql.stripLeading().toLowerCase(Locale.ROOT).startsWith("select")) {
                                metrics.getObject().executed(sql, info.getElapsedTime());
                            }
                        }
                    }
                };

                return ProxyDataSourceBuilder.create(source)
                        .name(name)
                        .listener(listener)
                        .build();
            }
        };
    }
}
