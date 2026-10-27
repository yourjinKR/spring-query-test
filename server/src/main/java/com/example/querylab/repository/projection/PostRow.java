package com.example.querylab.repository.projection;

import lombok.AllArgsConstructor;
import lombok.Getter;

@Getter
@AllArgsConstructor
public class PostRow {

    private final Long id;
    private final String title;
    private final String body;
}
